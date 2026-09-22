CREATE TABLE `baileys_state` (
	`id` int AUTO_INCREMENT NOT NULL,
	`stateKey` varchar(255) NOT NULL,
	`payload` text NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `baileys_state_id` PRIMARY KEY(`id`),
	CONSTRAINT `baileys_state_stateKey_unique` UNIQUE(`stateKey`)
);
