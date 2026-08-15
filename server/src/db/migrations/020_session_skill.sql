-- Link each session to a skill (Reading/Listening/…) taught in that meeting.
ALTER TABLE sessions ADD COLUMN skill_id TEXT REFERENCES skills(id);
