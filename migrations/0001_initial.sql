CREATE TABLE users (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    handle TEXT NOT NULL COLLATE NOCASE,
    rating INTEGER NOT NULL DEFAULT 1500,
    registration_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id),
    UNIQUE (guild_id, handle)
);
CREATE INDEX users_leaderboard ON users(guild_id, rating DESC, user_id);

CREATE TABLE challenges (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    problem_id TEXT NOT NULL,
    problem_name TEXT NOT NULL,
    problem_rating INTEGER NOT NULL,
    minutes INTEGER NOT NULL CHECK (minutes IN (40, 60, 80, 100, 120)),
    status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'complete', 'cancelled')),
    confirm_until INTEGER NOT NULL,
    starts_at INTEGER,
    ends_at INTEGER,
    created_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    dirty INTEGER NOT NULL DEFAULT 1,
    publish_owner TEXT,
    publish_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX challenges_waiting ON challenges(status, confirm_until);
CREATE INDEX challenges_dirty ON challenges(dirty, publish_until);

CREATE TABLE participants (
    challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    rating_start INTEGER NOT NULL,
    ready INTEGER NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL DEFAULT 'pending'
        CHECK (outcome IN ('pending', 'solved', 'failed', 'gave_up', 'void')),
    resolution_id TEXT,
    finished_at INTEGER,
    next_poll INTEGER NOT NULL DEFAULT 0,
    scan_from INTEGER NOT NULL DEFAULT 1,
    saw_testing INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    can_void INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX participants_due ON participants(outcome, next_poll, lease_until);

CREATE TABLE challenge_locks (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
    PRIMARY KEY (guild_id, user_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES users(guild_id, user_id)
);

CREATE TABLE rating_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    challenge_id TEXT NOT NULL REFERENCES challenges(id),
    problem_id TEXT NOT NULL,
    problem_name TEXT NOT NULL,
    old_rating INTEGER NOT NULL,
    new_rating INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (challenge_id, user_id),
    FOREIGN KEY (guild_id, user_id) REFERENCES users(guild_id, user_id) ON DELETE CASCADE
);
CREATE INDEX rating_events_history ON rating_events(guild_id, user_id, id DESC);
CREATE INDEX rating_events_problem ON rating_events(guild_id, user_id, problem_id);

CREATE TABLE registrations (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    problem_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    submit_until INTEGER NOT NULL,
    next_poll INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'failed', 'expired')),
    detail TEXT,
    dirty INTEGER NOT NULL DEFAULT 0,
    publish_after INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX registration_pending ON registrations(guild_id, user_id) WHERE status = 'pending';
CREATE INDEX registrations_due ON registrations(status, next_poll, lease_until);
CREATE INDEX registrations_dirty ON registrations(dirty, publish_after);

CREATE TABLE cf_accounts (
    handle TEXT PRIMARY KEY COLLATE NOCASE,
    cursor INTEGER NOT NULL DEFAULT 1,
    latest_id INTEGER NOT NULL DEFAULT 0,
    new_latest_id INTEGER NOT NULL DEFAULT 0,
    stop_id INTEGER NOT NULL DEFAULT 0,
    next_sync INTEGER,
    synced_at INTEGER,
    scanned INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    lease_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cf_accounts_due ON cf_accounts(next_sync, lease_until);

CREATE TABLE solved (
    handle TEXT NOT NULL COLLATE NOCASE REFERENCES cf_accounts(handle) ON DELETE CASCADE,
    problem_id TEXT NOT NULL,
    PRIMARY KEY (handle, problem_id)
);
CREATE TABLE pending_submissions (
    handle TEXT NOT NULL COLLATE NOCASE REFERENCES cf_accounts(handle) ON DELETE CASCADE,
    submission_id INTEGER NOT NULL,
    PRIMARY KEY (handle, submission_id)
);

CREATE TABLE api_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_at INTEGER NOT NULL DEFAULT 0,
    backoff_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO api_budget(id) VALUES (1);

CREATE TABLE cooldowns (key TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
CREATE TABLE interactions (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
CREATE INDEX interactions_expiry ON interactions(received_at);
CREATE TABLE leases (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until_at INTEGER NOT NULL);
