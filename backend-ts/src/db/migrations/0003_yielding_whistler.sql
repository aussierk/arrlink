ALTER TABLE `app_items` ADD `studio` text;--> statement-breakpoint
ALTER TABLE `app_items` ADD `network` text;--> statement-breakpoint
ALTER TABLE `app_items` ADD `series_type` text;--> statement-breakpoint
ALTER TABLE `app_items` ADD `video_codec_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_items` ADD `video_dynamic_range_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_items` ADD `audio_codec_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_items` ADD `audio_channels_json` text DEFAULT '[]' NOT NULL;