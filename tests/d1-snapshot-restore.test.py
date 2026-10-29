import copy
import importlib.util
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('d1_restore', ROOT / 'scripts/restore-d1-snapshot.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def fixture(with_metadata=False):
    db = sqlite3.connect(':memory:')
    mod.baseline(db, with_metadata)
    db.execute("INSERT INTO ledgers VALUES(1,'owner',9223372036854775807,CAST(X'00FFAB' AS TEXT),'op')")
    db.execute("INSERT INTO operations VALUES('op','owner','key','source','hash','{}','now')")
    db.execute("INSERT INTO images VALUES('image','owner','hash','image/png',4,'now',X'00FF01FE')")
    # REAL roundtrip in an integer-affinity column deliberately exercises type fidelity.
    db.execute("INSERT INTO ledgers VALUES(2,'other',0.125,'{}','op')")
    if with_metadata:
        db.execute("INSERT INTO __appgarden_migrations(id,name,applied_at) VALUES (1,'0000.sql','2026-10-01')")
        db.execute("INSERT INTO __appgarden_migrations(id,name,applied_at) VALUES (2,'0001.sql','2026-10-02')")
        # Preserve a high-water mark larger than MAX(id), which must not be
        # inferred from the rows on restore.
        db.execute("UPDATE sqlite_sequence SET seq=42 WHERE name='__appgarden_migrations'")
    snapshot = {'format': 'd1-logical-snapshot-v1', 'captured_at': '2026-10-29T00:00:00Z', 'complete': True,
                'schema': [dict(zip(('type','name','tbl_name','sql'), r)) for r in mod.schema(db)],
                'tables': {}, 'row_counts': {}}
    selected=mod.TABLES | mod.META_TABLES if with_metadata else mod.TABLES
    for table in sorted(selected):
        cols = [{'name':r[1], 'pk':r[5], 'hidden':r[6]} for r in db.execute('PRAGMA table_xinfo("'+table+'")')]
        parts=[]
        for c in cols:
            n='"'+c['name']+'"'
            parts += [f'typeof({n})',f"CASE typeof({n}) WHEN 'null' THEN NULL WHEN 'integer' THEN CAST({n} AS TEXT) WHEN 'real' THEN printf('%!.17g',{n}) ELSE lower(hex(CAST({n} AS BLOB))) END"]
        rows=[]
        for row in db.execute('SELECT '+','.join(parts)+' FROM "'+table+'"'):
            cells=[]
            for i in range(0,len(row),2):
                typ, value=row[i:i+2]
                cells.append({'type':typ} if typ=='null' else {'type':typ, ('hex' if typ in ('text','blob') else 'value'):value})
            rows.append(cells)
        snapshot['tables'][table]={'columns':cols, 'rows':rows}
        snapshot['row_counts'][table]=len(rows)
    db.close()
    return snapshot


class RestoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.out = str(Path(self.temp.name)/'restore.sqlite3')
        self.data = fixture()

    def tearDown(self):
        self.temp.cleanup()

    def test_full_restore_preserves_types_blob_raw_text_schema_and_history(self):
        counts=mod.restore(self.data,self.out)
        self.assertEqual(counts,{'image_recognitions':0,'images':1,'ledgers':2,'operations':1})
        self.assertEqual(os.stat(self.out).st_mode & 0o777,0o600)
        db=sqlite3.connect(self.out)
        self.assertEqual(db.execute("SELECT typeof(revision),CAST(revision AS TEXT),hex(CAST(data AS BLOB)) FROM ledgers WHERE id=1").fetchone(),('integer','9223372036854775807','00FFAB'))
        self.assertEqual(db.execute("SELECT typeof(revision),revision FROM ledgers WHERE id=2").fetchone(),('real',0.125))
        self.assertEqual(db.execute('SELECT hex(bytes) FROM images').fetchone()[0],'00FF01FE')
        self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        db.close()

    def test_refuses_existing_output_and_preserves_file(self):
        Path(self.out).write_bytes(b'preserve')
        with self.assertRaises(FileExistsError): mod.restore(self.data,self.out)
        self.assertEqual(Path(self.out).read_bytes(),b'preserve')

    def test_sites_migrations_and_exact_sequence_are_restored_and_verified(self):
        data=fixture(with_metadata=True)
        counts=mod.restore(data,self.out)
        self.assertEqual(counts['__appgarden_migrations'],2)
        self.assertEqual(counts['sqlite_sequence'],1)
        db=sqlite3.connect(self.out)
        self.assertEqual(db.execute('SELECT id,name,applied_at FROM __appgarden_migrations ORDER BY id').fetchall(),[(1,'0000.sql','2026-10-01'),(2,'0001.sql','2026-10-02')])
        self.assertEqual(db.execute("SELECT name,seq FROM sqlite_sequence").fetchall(),[('__appgarden_migrations',42)])
        self.assertIsNotNone(db.execute("SELECT name FROM sqlite_schema WHERE name='sqlite_autoindex___appgarden_migrations_1'").fetchone())
        sql_path=str(Path(self.temp.name)/'with-migrations.sql');mod.write_d1_sql(data,sql_path)
        replay=sqlite3.connect(':memory:');replay.executescript(Path(sql_path).read_text())
        self.assertEqual(mod.schema(db),mod.schema(replay))
        for name in sorted(mod.TABLES | mod.META_TABLES):
            cols=[c['name'] for c in data['tables'][name]['columns']]
            self.assertEqual(mod.observed_cells(db,name,cols),mod.observed_cells(replay,name,cols))
        db.close();replay.close()

    def test_sites_metadata_or_sequence_tampering_fails_closed(self):
        examples=[]
        a=fixture(with_metadata=True);del a['tables']['sqlite_sequence'];del a['row_counts']['sqlite_sequence'];examples.append(a)
        a=fixture(with_metadata=True);a['schema']=[r for r in a['schema'] if r['name']!='sqlite_autoindex___appgarden_migrations_1'];examples.append(a)
        a=fixture(with_metadata=True);next(r for r in a['schema'] if r['name']=='__appgarden_migrations')['sql']+='; DROP TABLE ledgers';examples.append(a)
        a=fixture(with_metadata=True);a['row_counts']['sqlite_sequence']=0;examples.append(a)
        for bad in examples:
            with self.subTest():
                with self.assertRaises(ValueError):mod.restore(bad,self.out)
                self.assertFalse(Path(self.out).exists())

    def test_incomplete_or_changed_schema_rejected_without_output(self):
        examples=[]
        a=copy.deepcopy(self.data);a['complete']=False;examples.append(a)
        a=copy.deepcopy(self.data);a['row_counts']['operations']=2;examples.append(a)
        a=copy.deepcopy(self.data);del a['tables']['images'];examples.append(a)
        a=copy.deepcopy(self.data);a['tables']['images']['rows'][0][-1]['hex']='zz';examples.append(a)
        a=copy.deepcopy(self.data);a['schema'].append({'type':'trigger','name':'malicious','tbl_name':'ledgers','sql':'CREATE TRIGGER malicious AFTER INSERT ON ledgers BEGIN DELETE FROM operations; END'});examples.append(a)
        a=copy.deepcopy(self.data);a['schema']=[r for r in a['schema'] if r['name']!='owner_key'];examples.append(a)
        a=copy.deepcopy(self.data);a['schema'].append({'type':'table','name':'other','tbl_name':'other','sql':'CREATE TABLE other(x)'});examples.append(a)
        for bad in examples:
            with self.subTest(case=examples.index(bad)):
                with self.assertRaises(ValueError):mod.restore(bad,self.out)
                self.assertFalse(Path(self.out).exists())

    def test_d1_script_restores_equivalent_sqlite_data(self):
        mod.restore(self.data,self.out)
        d1_sql = str(Path(self.temp.name)/'isolated.sql')
        mod.write_d1_sql(self.data,d1_sql)
        sql = Path(d1_sql).read_text()
        self.assertNotIn('BEGIN TRANSACTION',sql)
        self.assertNotIn('COMMIT;',sql)
        self.assertEqual(os.stat(d1_sql).st_mode & 0o777,0o600)
        db=sqlite3.connect(':memory:')
        db.executescript(sql)
        source=sqlite3.connect(self.out)
        self.assertEqual(mod.schema(db),mod.schema(source))
        for name in sorted(mod.TABLES):
            cols=[c['name'] for c in self.data['tables'][name]['columns']]
            self.assertEqual(mod.observed_cells(db,name,cols),mod.observed_cells(source,name,cols))
        db.close();source.close()

    def test_d1_large_text_and_blob_reassembled_without_loss(self):
        receipt = next(i for i,c in enumerate(self.data['tables']['operations']['columns']) if c['name']=='receipt')
        image = next(i for i,c in enumerate(self.data['tables']['images']['columns']) if c['name']=='bytes')
        self.data['tables']['operations']['rows'][0][receipt]['hex'] = ('007bff7d' * 40000)
        self.data['tables']['images']['rows'][0][image]['hex'] = ('00ff017f' * 50000)
        mod.restore(self.data,self.out)
        d1_sql = str(Path(self.temp.name)/'large.sql')
        mod.write_d1_sql(self.data,d1_sql)
        sql = Path(d1_sql).read_text()
        self.assertTrue(all(len(s.encode())<=100000 for s in sql.split(';')))
        db=sqlite3.connect(':memory:');db.executescript(sql)
        source=sqlite3.connect(self.out)
        for name in ('images','operations'):
            cols=[c['name'] for c in self.data['tables'][name]['columns']]
            self.assertEqual(mod.observed_cells(db,name,cols),mod.observed_cells(source,name,cols))
        db.close();source.close()

    def test_d1_statement_limits_fail_closed(self):
        self.data['tables']['images']['rows'][0][0]['hex'] = 'ab' * 60000
        d1_sql = str(Path(self.temp.name)/'isolated.sql')
        with self.assertRaisesRegex(ValueError, 'statement exceeds'):
            mod.write_d1_sql(self.data,d1_sql)
        self.assertFalse(Path(d1_sql).exists())

    def test_mid_restore_failure_deletes_new_partial_file(self):
        # The second row violates the primary key; no partial database remains.
        self.data['tables']['operations']['rows'].append(copy.deepcopy(self.data['tables']['operations']['rows'][0]))
        self.data['row_counts']['operations']+=1
        with self.assertRaises(sqlite3.IntegrityError):mod.restore(self.data,self.out)
        self.assertFalse(Path(self.out).exists())


if __name__=='__main__':unittest.main()
