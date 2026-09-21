CREATE TABLE `training_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectKey` varchar(100) NOT NULL,
	`checklist` text NOT NULL,
	`answers` text NOT NULL,
	`summary` text NOT NULL,
	`approved` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `training_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `training_sessions_projectKey_unique` UNIQUE(`projectKey`)
);
