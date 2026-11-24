CREATE TABLE "conversation_memory" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"covered_through_id" integer DEFAULT 0 NOT NULL,
	"covered_turns" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_memory" ADD CONSTRAINT "conversation_memory_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;