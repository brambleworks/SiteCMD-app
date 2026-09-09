ALTER TABLE fix_attempts ADD COLUMN target_occurrence_count INTEGER;

DROP INDEX IF EXISTS uq_fix_attempts_active;

CREATE UNIQUE INDEX uq_fix_attempts_active
    ON fix_attempts(
        project_id, env_url, check_id, target_kind,
        COALESCE(target_relative_path, ''), COALESCE(target_line, -1)
    )
    WHERE status IN ('briefed', 'verify_requested', 'verifying');
