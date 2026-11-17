CREATE TABLE mc_clips (
	id text PRIMARY KEY NOT NULL,
	event_id text NOT NULL REFERENCES events(id),
	context text NOT NULL,
	text text NOT NULL,
	state text NOT NULL,
	audio_key text,
	lease text NOT NULL,
	lease_until bigint DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX mc_clips_event ON mc_clips (event_id, created_at);
ALTER TABLE events ADD mc_enabled integer DEFAULT 1 NOT NULL;
ALTER TABLE events ADD announcement_id text;
ALTER TABLE events ADD announcement_kind text;
ALTER TABLE events ADD intro_enabled integer DEFAULT 0 NOT NULL;
ALTER TABLE events ADD intro_text text DEFAULT '' NOT NULL;
ALTER TABLE events ADD outro_enabled integer DEFAULT 0 NOT NULL;
ALTER TABLE events ADD outro_text text DEFAULT '' NOT NULL;
ALTER TABLE events ADD end_after_track integer DEFAULT 0 NOT NULL;
ALTER TABLE events ADD show_ended integer DEFAULT 0 NOT NULL;
ALTER TABLE tracks ADD mc_text text DEFAULT '' NOT NULL;
ALTER TABLE events ADD intro_played integer DEFAULT 0 NOT NULL;
