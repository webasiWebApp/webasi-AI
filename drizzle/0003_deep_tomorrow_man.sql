CREATE TABLE `event_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventType` varchar(80) NOT NULL,
	`severity` enum('info','warning','error') NOT NULL DEFAULT 'info',
	`title` varchar(200) NOT NULL,
	`detail` text NOT NULL,
	`clientId` varchar(80),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `event_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `insights` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(240) NOT NULL,
	`detail` text NOT NULL,
	`category` varchar(60) NOT NULL,
	`status` enum('suggested','approved','dismissed') NOT NULL DEFAULT 'suggested',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `insights_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`orderKey` varchar(80) NOT NULL,
	`clientId` varchar(80) NOT NULL,
	`waId` varchar(32) NOT NULL,
	`packageName` varchar(180) NOT NULL,
	`depositAmount` int NOT NULL,
	`state` enum('awaiting_deposit','slip_received','confirmed_by_owner','cancelled') NOT NULL DEFAULT 'awaiting_deposit',
	`slipMediaId` varchar(255),
	`notes` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_orderKey_unique` UNIQUE(`orderKey`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectKey` varchar(100) NOT NULL,
	`name` varchar(180) NOT NULL,
	`status` enum('draft','training','ready','approved','active','archived') NOT NULL DEFAULT 'draft',
	`readiness` int NOT NULL DEFAULT 0,
	`version` int NOT NULL DEFAULT 1,
	`snapshot` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_projectKey_unique` UNIQUE(`projectKey`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`singletonKey` varchar(20) NOT NULL,
	`businessName` varchar(180) NOT NULL,
	`bankDetails` text NOT NULL,
	`notificationEmail` varchar(320),
	`whatsappMonthlyCap` int NOT NULL DEFAULT 900,
	`geminiDailyCap` int NOT NULL DEFAULT 500,
	`webasiEnabled` int NOT NULL DEFAULT 0,
	`shadowMode` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `settings_singletonKey_unique` UNIQUE(`singletonKey`)
);
