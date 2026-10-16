CREATE TABLE `image_recognitions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`result_json` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `recognitions_owner_created` ON `image_recognitions` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `recognitions_owner_fingerprint` ON `image_recognitions` (`owner_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`sha256` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`uploaded_at` text NOT NULL,
	`bytes` blob NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_owner_hash` ON `images` (`owner_id`,`sha256`);