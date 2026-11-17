-- PostgreSQL equivalent of drizzle/0000_low_masque.sql (Node/Render + Neon runtime).
-- Millisecond timestamps use bigint; fractional seconds use double precision.
CREATE TABLE events (
	id text PRIMARY KEY NOT NULL,
	owner_id text NOT NULL,
	title text NOT NULL,
	artist text NOT NULL,
	album text DEFAULT '' NOT NULL,
	location text DEFAULT '' NOT NULL,
	queue_open integer DEFAULT 1 NOT NULL,
	created_at bigint NOT NULL,
	mode text DEFAULT 'album' NOT NULL,
	pending_mode text,
	mic_after_track text,
	status text DEFAULT 'idle' NOT NULL,
	current_track text,
	current_entry text,
	album_cursor text,
	started_at bigint,
	position double precision DEFAULT 0 NOT NULL,
	version integer DEFAULT 0 NOT NULL,
	controller_hash text,
	controller_until bigint
);
CREATE INDEX events_owner ON events (owner_id);
CREATE TABLE tracks (
	id text PRIMARY KEY NOT NULL,
	event_id text NOT NULL REFERENCES events(id),
	title text NOT NULL,
	position integer NOT NULL,
	duration double precision DEFAULT 0 NOT NULL,
	beat_duration double precision,
	audio_key text NOT NULL,
	beat_key text,
	mime text NOT NULL,
	beat_mime text
);
CREATE INDEX tracks_event ON tracks (event_id, position);
CREATE TABLE entries (
	id text PRIMARY KEY NOT NULL,
	event_id text NOT NULL REFERENCES events(id),
	track_id text NOT NULL REFERENCES tracks(id),
	name text NOT NULL,
	guest_hash text NOT NULL,
	status text DEFAULT 'waiting' NOT NULL,
	created_at bigint NOT NULL
);
CREATE INDEX entries_event ON entries (event_id, status, created_at);
CREATE TABLE subscribers (
	id text PRIMARY KEY NOT NULL,
	event_id text NOT NULL REFERENCES events(id),
	email text NOT NULL,
	created_at bigint NOT NULL,
	consent text NOT NULL
);
CREATE UNIQUE INDEX subscriber_unique ON subscribers (event_id, email);
