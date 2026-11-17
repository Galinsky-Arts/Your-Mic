CREATE TABLE track_plays (
	event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
	playback_id text NOT NULL,
	track_id text NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
	kind text NOT NULL,
	played_at bigint NOT NULL,
	PRIMARY KEY (event_id, playback_id)
);
CREATE INDEX track_plays_event_track ON track_plays (event_id, track_id);
