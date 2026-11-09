-- Pages publiées depuis une session (Session.pages, demandé par la sidebar à chaque relevé) : versions par session.
CREATE INDEX IF NOT EXISTS shared_page_versions_session_idx ON shared_page_versions (session_id) WHERE session_id IS NOT NULL;
