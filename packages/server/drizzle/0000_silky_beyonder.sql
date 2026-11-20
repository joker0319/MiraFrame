CREATE TABLE "agentmessage" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"agent" varchar(100) NOT NULL,
	"role" varchar(50) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agentrun" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"status" varchar(50) DEFAULT 'queued' NOT NULL,
	"current_agent" varchar,
	"progress" real DEFAULT 0 NOT NULL,
	"route_decision" text,
	"patch_plan" text,
	"error" text,
	"resource_type" varchar,
	"resource_id" integer,
	"thread_id" varchar,
	"provider_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"description" text,
	"image_url" text,
	"reference_images" jsonb DEFAULT '[]'::jsonb,
	"face_embedding" text,
	"visual_notes" text,
	"approved_name" varchar,
	"approved_description" text,
	"approved_image_url" text,
	"approved_at" timestamp with time zone,
	"approval_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"run_id" integer,
	"agent" varchar(100) NOT NULL,
	"role" varchar(50) NOT NULL,
	"content" text NOT NULL,
	"summary" text,
	"progress" real,
	"is_loading" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"story" text,
	"style" varchar(100) DEFAULT 'anime' NOT NULL,
	"summary" text,
	"story_outline" jsonb,
	"visual_bible" text,
	"outline_approved" boolean DEFAULT false NOT NULL,
	"video_url" text,
	"status" varchar(50) DEFAULT 'draft' NOT NULL,
	"text_provider_override" varchar,
	"image_provider_override" varchar,
	"video_provider_override" varchar,
	"target_shot_count" integer,
	"character_hints" jsonb DEFAULT '[]'::jsonb,
	"creation_mode" varchar,
	"universe_id" integer,
	"chapter_number" integer,
	"chapter_title" varchar,
	"reference_images" jsonb DEFAULT '[]'::jsonb,
	"exports" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shot_character_binding" (
	"shot_id" integer NOT NULL,
	"character_id" integer NOT NULL,
	CONSTRAINT "shot_character_binding_shot_id_character_id_pk" PRIMARY KEY("shot_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "shot" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"order" integer NOT NULL,
	"description" text NOT NULL,
	"prompt" text,
	"image_prompt" text,
	"image_url" text,
	"video_url" text,
	"duration" real,
	"camera" varchar,
	"motion_note" text,
	"scene" text,
	"action" text,
	"expression" varchar,
	"lighting" varchar,
	"dialogue" text,
	"sfx" varchar,
	"tts_url" text,
	"bgm_type" varchar,
	"seed" integer,
	"character_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_description" text,
	"approved_prompt" text,
	"approved_image_prompt" text,
	"approved_duration" real,
	"approved_camera" varchar,
	"approved_motion_note" text,
	"approved_scene" text,
	"approved_action" text,
	"approved_expression" varchar,
	"approved_lighting" varchar,
	"approved_dialogue" text,
	"approved_sfx" varchar,
	"approved_character_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"approval_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agentmessage" ADD CONSTRAINT "agentmessage_run_id_agentrun_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agentrun"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentrun" ADD CONSTRAINT "agentrun_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character" ADD CONSTRAINT "character_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_run_id_agentrun_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agentrun"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_character_binding" ADD CONSTRAINT "shot_character_binding_shot_id_shot_id_fk" FOREIGN KEY ("shot_id") REFERENCES "public"."shot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_character_binding" ADD CONSTRAINT "shot_character_binding_character_id_character_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."character"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot" ADD CONSTRAINT "shot_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agentmsg_run_idx" ON "agentmessage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agentrun_project_idx" ON "agentrun" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agentrun_thread_idx" ON "agentrun" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "agentrun_resource_idx" ON "agentrun" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "character_project_idx" ON "character" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "msg_project_idx" ON "message" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "msg_run_idx" ON "message" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "scb_shot_idx" ON "shot_character_binding" USING btree ("shot_id");--> statement-breakpoint
CREATE INDEX "scb_char_idx" ON "shot_character_binding" USING btree ("character_id");--> statement-breakpoint
CREATE INDEX "shot_project_idx" ON "shot" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "shot_order_idx" ON "shot" USING btree ("order");