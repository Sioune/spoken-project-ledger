#!/usr/bin/env python3
"""Restore a verified snapshot to a NEW local SQLite file only.

This accepts the four application tables and, when present, the independently
verified Sites migration metadata and SQLite sequence. Unknown schema is an
error, not executable input. D1's reserved platform tables are excluded.
"""
import argparse
import collections
import json
import math
import os
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ('0000_outstanding_ultimatum.sql', '0001_sharp_yellowjacket.sql')
TABLES = frozenset(('ledgers', 'operations', 'images', 'image_recognitions'))
META_TABLES = frozenset(('__appgarden_migrations', 'sqlite_sequence'))
# The exact Sites-owned table definition was read from the production schema;
# it is trusted code, not a SQL statement taken from the snapshot at runtime.
APPGARDEN_SQL = 'CREATE TABLE "__appgarden_migrations"(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'
INTEGER = re.compile(r'(?:0|-[1-9][0-9]*|[1-9][0-9]*)\Z')
HEX = re.compile(r'(?:[0-9a-fA-F]{2})*\Z')


def fail(message):
    raise ValueError(message)


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('duplicate JSON key')
        result[key] = value
    return result


def baseline(connection, with_metadata=False):
    for filename in MIGRATIONS:
        connection.executescript((ROOT / 'drizzle' / filename).read_text(encoding='utf-8'))
    if with_metadata:
        connection.execute(APPGARDEN_SQL)


def snapshot_tables(snapshot):
    tables, counts = snapshot.get('tables'), snapshot.get('row_counts')
    if not isinstance(tables, dict) or not isinstance(counts, dict) or set(tables) != set(counts):
        fail('snapshot table set incomplete or unsupported')
    selected = frozenset(tables)
    if selected not in (TABLES, TABLES | META_TABLES):
        fail('snapshot table set incomplete or unsupported')
    return selected


def schema(connection):
    return connection.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').fetchall()


def ddl_equal(a, b):
    # Do not attempt to execute SQL from a snapshot. Only compare to trusted
    # checked-in SQL. Normalizing whitespace outside literals allows harmless
    # line wrapping; all token spelling and quoted identifiers remain exact.
    def norm(s):
        if s is None:
            return None
        return re.sub(r'\s+', ' ', s.strip().rstrip(';')).strip()
    return norm(a) == norm(b)


def verify_schema(records, trusted):
    if not isinstance(records, list):
        fail('schema is missing')
    found = {}
    for row in records:
        if not isinstance(row, dict) or set(row) != {'type', 'name', 'tbl_name', 'sql'}:
            fail('malformed schema row')
        typ, name, table, sql = (row[k] for k in ('type', 'name', 'tbl_name', 'sql'))
        if not all(isinstance(v, str) for v in (typ, name, table)) or not (sql is None or isinstance(sql, str)):
            fail('malformed schema values')
        if table.startswith('_cf_'):
            if not (typ == 'table' and name == table and name in ('_cf_KV', '_cf_METADATA')):
                fail('unsupported platform schema object')
            continue
        key = (typ, name, table)
        if key in found:
            fail('duplicate schema object')
        found[key] = sql
    expected = {(typ, name, table): sql for typ, name, table, sql in trusted}
    if found.keys() != expected.keys() or any(not ddl_equal(found[k], expected[k]) for k in expected):
        fail('schema differs from trusted checked-in migrations')


def cell_value(cell):
    if not isinstance(cell, dict) or not isinstance(cell.get('type'), str):
        fail('malformed cell')
    typ = cell['type']
    if typ == 'null' and set(cell) == {'type'}:
        return None, '?'
    if typ == 'integer' and set(cell) == {'type', 'value'}:
        text = cell['value']
        if not isinstance(text, str) or not INTEGER.fullmatch(text):
            fail('invalid integer')
        number = int(text)
        if not -(2**63) <= number < 2**63:
            fail('integer out of range')
        return number, '?'
    if typ == 'real' and set(cell) == {'type', 'value'}:
        text = cell['value']
        if not isinstance(text, str) or len(text) > 32:
            fail('invalid real')
        try:
            value = float(text)
        except ValueError:
            fail('invalid real')
        if not math.isfinite(value):
            fail('non-finite real')
        return value, '?'
    if typ in ('text', 'blob') and set(cell) == {'type', 'hex'}:
        text = cell['hex']
        if not isinstance(text, str) or len(text) > 4000000 or not HEX.fullmatch(text):
            fail('invalid hex cell')
        data = bytes.fromhex(text)
        return data, 'CAST(? AS TEXT)' if typ == 'text' else '?'
    fail('unknown or malformed cell type')


def value_key(cell):
    if cell['type'] in ('text', 'blob'):
        return (cell['type'], cell['hex'].lower())
    return (cell['type'], cell.get('value'))


def observed_cells(connection, table, cols):
    parts = []
    for name in cols:
        col = '"' + name.replace('"', '""') + '"'
        # printf matches the wire format; integer values never pass via JS numbers.
        parts.extend((f'typeof({col})', f"CASE typeof({col}) WHEN 'null' THEN NULL WHEN 'integer' THEN CAST({col} AS TEXT) WHEN 'real' THEN printf('%!.17g', {col}) ELSE lower(hex(CAST({col} AS BLOB))) END"))
    query = 'SELECT ' + ','.join(parts) + ' FROM "' + table + '"'
    out = []
    for row in connection.execute(query):
        out.append(tuple((row[i], row[i+1]) for i in range(0, len(row), 2)))
    return collections.Counter(out)


def restore(snapshot, output):
    if not isinstance(snapshot, dict) or snapshot.get('format') != 'd1-logical-snapshot-v1' or snapshot.get('complete') is not True:
        fail('snapshot format or completeness marker invalid')
    if not isinstance(snapshot.get('captured_at'), str) or not snapshot['captured_at']:
        fail('capture timestamp missing')
    selected = snapshot_tables(snapshot)
    tables, counts = snapshot['tables'], snapshot['row_counts']
    with_metadata = META_TABLES.issubset(selected)
    trusted = sqlite3.connect(':memory:')
    try:
        baseline(trusted, with_metadata)
        verify_schema(snapshot.get('schema'), schema(trusted))
        specs = {}
        for name in sorted(selected):
            table = tables[name]
            if not isinstance(table, dict) or set(table) != {'columns', 'rows'} or not isinstance(table['rows'], list):
                fail('malformed table')
            expected_cols = [{'name': r[1], 'pk': r[5], 'hidden': r[6]} for r in trusted.execute('PRAGMA table_xinfo("' + name + '")')]
            if table['columns'] != expected_cols or any(c['hidden'] != 0 for c in expected_cols):
                fail('column specification differs from trusted schema')
            if type(counts[name]) is not int or counts[name] != len(table['rows']):
                fail('row count mismatch')
            for row in table['rows']:
                if not isinstance(row, list) or len(row) != len(expected_cols):
                    fail('row width mismatch')
                for cell in row:
                    cell_value(cell)
            specs[name] = expected_cols
    finally:
        trusted.close()
    # Refuse existing files, symlinks and remote databases. Never overwrite.
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    os.close(descriptor)
    try:
        db = sqlite3.connect(output)
        try:
            db.execute('PRAGMA trusted_schema=OFF')
            db.execute('PRAGMA foreign_keys=ON')
            baseline(db, with_metadata)
            db.execute('BEGIN')
            for name in sorted(selected, key=lambda n: (n == 'sqlite_sequence', n)):
                # Explicit inserts into an AUTOINCREMENT table advance SQLite's
                # sequence. Restore the captured sequence only after those rows.
                if name == 'sqlite_sequence':
                    db.execute('DELETE FROM sqlite_sequence')
                cols = specs[name]
                quoted = ','.join('"' + c['name'].replace('"', '""') + '"' for c in cols)
                for row in tables[name]['rows']:
                    decoded = [cell_value(cell) for cell in row]
                    sql = 'INSERT INTO "' + name + '" (' + quoted + ') VALUES (' + ','.join(x[1] for x in decoded) + ')'
                    db.execute(sql, tuple(x[0] for x in decoded))
            db.commit()
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                fail('integrity check failed')
            if db.execute('PRAGMA foreign_key_check').fetchall():
                fail('foreign key check failed')
            baseline_db = sqlite3.connect(':memory:')
            try:
                baseline(baseline_db, with_metadata)
                if schema(db) != schema(baseline_db):
                    fail('restored schema/index/trigger mismatch')
            finally:
                baseline_db.close()
            for name in sorted(selected):
                expected = collections.Counter(tuple(value_key(cell) for cell in row) for row in tables[name]['rows'])
                if observed_cells(db, name, [c['name'] for c in specs[name]]) != expected:
                    fail('restored cells differ in type or value')
        finally:
            db.close()
    except BaseException:
        try:
            os.unlink(output)
        except OSError:
            pass
        raise
    return {name: counts[name] for name in sorted(selected)}


def write_d1_sql(snapshot, output):
    """Produce a D1 import script from an already verified snapshot.

    Explicit BEGIN/COMMIT are omitted because D1 executes imports in its
    own transaction. Known non-key large TEXT/BLOB columns are restored in
    bounded byte chunks. Unknown oversized statements fail closed.
    """
    selected = snapshot_tables(snapshot)
    temp = sqlite3.connect(':memory:')
    try:
        baseline(temp, META_TABLES.issubset(selected))
        rows = schema(temp)
        tables_sql = [sql for typ, name, _, sql in rows if typ == 'table' and name != 'sqlite_sequence' and sql is not None]
        other_sql = [sql for typ, name, _, sql in rows if typ in ('index', 'view', 'trigger') and sql is not None]
    finally:
        temp.close()
    statements = list(tables_sql)
    chunkable = {('ledgers', 'data'), ('operations', 'receipt'),
                 ('image_recognitions', 'result_json'), ('images', 'bytes')}
    chunk_bytes = 32000

    def literal(cell):
        cell_value(cell)
        typ = cell['type']
        if typ == 'null':
            return 'NULL'
        if typ == 'integer':
            return cell['value']
        if typ == 'real':
            return 'CAST(' + cell['value'] + ' AS REAL)'
        if typ == 'text':
            return "CAST(X'" + cell['hex'] + "' AS TEXT)"
        return "X'" + cell['hex'] + "'"

    for name in sorted(selected, key=lambda n: (n == 'sqlite_sequence', n)):
        table = snapshot['tables'][name]
        names = [c['name'] for c in table['columns']]
        columns = ','.join('"' + c.replace('"', '""') + '"' for c in names)
        if name == 'sqlite_sequence':
            statements.append('DELETE FROM sqlite_sequence')
        for row in table['rows']:
            row_id = literal(row[names.index('id')]) if 'id' in names else None
            cells = []
            updates = []
            for column, cell in zip(names, row):
                cell_value(cell)
                typ = cell['type']
                if (name, column) in chunkable and typ in ('text', 'blob'):
                    cells.append("CAST(X'' AS TEXT)" if typ == 'text' else "X''")
                    hex_data = cell['hex']
                    qcolumn = '"' + column.replace('"', '""') + '"'
                    for pos in range(0, len(hex_data), chunk_bytes * 2):
                        part = hex_data[pos:pos + chunk_bytes * 2]
                        updates.append('UPDATE "' + name + '" SET ' + qcolumn +
                                       ' = CAST(CAST(' + qcolumn + " AS BLOB) || X'" + part +
                                       "' AS " + ('TEXT' if typ == 'text' else 'BLOB') +
                                       ') WHERE "id" = ' + row_id)
                else:
                    cells.append(literal(cell))
            statements.append('INSERT INTO "' + name + '" (' + columns + ') VALUES (' + ','.join(cells) + ')')
            statements.extend(updates)
    statements.extend(other_sql)
    if any(len((s + ';').encode('utf-8')) > 100000 for s in statements):
        fail('D1 SQL statement exceeds documented 100000-byte limit')
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as f:
            f.write('\n'.join(s.rstrip().rstrip(';') + ';' for s in statements) + '\n')
    except BaseException:
        try:
            os.unlink(output)
        except OSError:
            pass
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('output', type=Path, help='new local SQLite file; must not exist')
    parser.add_argument('--d1-sql', type=Path, help='optional NEW SQL file for import into an empty isolated D1')
    args = parser.parse_args()
    try:
        raw = args.snapshot.read_bytes()
        if len(raw) > 256 * 1024 * 1024:
            fail('snapshot too large')
        parsed = json.loads(raw, object_pairs_hook=no_duplicate_keys, parse_constant=lambda _: fail('non-JSON constant'))
        counts = restore(parsed, str(args.output))
        if args.d1_sql is not None:
            write_d1_sql(parsed, str(args.d1_sql))
    except (ValueError, OSError, sqlite3.Error, UnicodeError) as exc:
        print('Restore refused:', str(exc), file=sys.stderr)
        return 1
    print(json.dumps({'status': 'verified', 'row_counts': counts}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
