ALTER TABLE resources ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500) NULL AFTER capacity;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500) NULL AFTER public_description;
