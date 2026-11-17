-- Node runtime only: replaces the Cloudflare R2 bucket. Audio objects are kept
-- as 1 MiB bytea chunks (see lib/pg-bucket.ts).
CREATE TABLE storage_objects (
	key text PRIMARY KEY NOT NULL,
	size bigint NOT NULL,
	etag text NOT NULL,
	content_type text,
	uploaded_at bigint NOT NULL
);
CREATE TABLE storage_chunks (
	key text NOT NULL REFERENCES storage_objects(key) ON DELETE CASCADE,
	idx integer NOT NULL,
	data bytea NOT NULL,
	PRIMARY KEY (key, idx)
);
