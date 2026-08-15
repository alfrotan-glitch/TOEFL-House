-- Level-level minimum viable class size (rule) + ensure class columns for merge tracking
ALTER TABLE levels ADD COLUMN min_viable_size INTEGER NOT NULL DEFAULT 5;

ALTER TABLE classes ADD COLUMN merged_into_id TEXT REFERENCES classes(id);
ALTER TABLE classes ADD COLUMN notes TEXT;
