ALTER TABLE events ADD local_session_id text DEFAULT '' NOT NULL;
ALTER TABLE events ADD local_sequence integer DEFAULT 0 NOT NULL;
