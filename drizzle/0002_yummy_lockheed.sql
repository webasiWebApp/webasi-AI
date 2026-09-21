CREATE TABLE `conversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`clientId` varchar(80) NOT NULL,
	`waId` varchar(32) NOT NULL,
	`profileName` varchar(160),
	`state` enum('new','collecting','brief_complete','awaiting_deposit','slip_received','confirmed_by_owner','needs_owner','paused','abandoned','cancelled') NOT NULL DEFAULT 'new',
	`isPaused` int NOT NULL DEFAULT 0,
	`missingFields` text NOT NULL,
	`extractedFields` text NOT NULL,
	`recentMessages` text NOT NULL,
	`lastClientMessageAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`),
	CONSTRAINT `conversations_clientId_unique` UNIQUE(`clientId`),
	CONSTRAINT `conversations_waId_unique` UNIQUE(`waId`)
);
--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`id` int AUTO_INCREMENT NOT NULL,
	`periodKey` varchar(20) NOT NULL,
	`outboundWhatsApp` int NOT NULL DEFAULT 0,
	`geminiRequests` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `usage_counters_id` PRIMARY KEY(`id`),
	CONSTRAINT `usage_counters_periodKey_unique` UNIQUE(`periodKey`)
);
