CREATE TABLE `ledgers` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`revision` integer NOT NULL,
	`data` text NOT NULL,
	`last_operation` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`source_event_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`receipt` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_key` ON `operations` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `owner_source` ON `operations` (`owner_id`,`source_event_id`);