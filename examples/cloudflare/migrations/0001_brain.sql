CREATE TABLE `changes` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_id` text NOT NULL,
	`revision` integer NOT NULL,
	`hash` text NOT NULL,
	`content` text NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`request_id` text NOT NULL
);

CREATE UNIQUE INDEX `changes_request_id` ON `changes` (`request_id`);
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`hash` text NOT NULL,
	`revision` integer NOT NULL,
	`system` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL,
	`request_id` text NOT NULL
);

CREATE UNIQUE INDEX `pages_request_id` ON `pages` (`request_id`);

CREATE TRIGGER pages_audit_insert AFTER INSERT ON pages BEGIN
  INSERT INTO changes (page_id,revision,hash,content,at,actor,reason,request_id)
  VALUES (NEW.id,NEW.revision,NEW.hash,NEW.content,NEW.updated_at,NEW.actor,NEW.reason,NEW.request_id);
END;

CREATE TRIGGER pages_audit_update AFTER UPDATE ON pages BEGIN
  INSERT INTO changes (page_id,revision,hash,content,at,actor,reason,request_id)
  VALUES (NEW.id,NEW.revision,NEW.hash,NEW.content,NEW.updated_at,NEW.actor,NEW.reason,NEW.request_id);
END;
