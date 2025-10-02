BEGIN TRANSACTION;

-- Normalize orientation to (min, max)
UPDATE friendships
SET user_id_a = CASE WHEN user_id_a <= user_id_b THEN user_id_a ELSE user_id_b END,
    user_id_b = CASE WHEN user_id_a <= user_id_b THEN user_id_b ELSE user_id_a END;

-- Remove any dup rows that normalization may have created
DELETE FROM friendships
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM friendships GROUP BY user_id_a, user_id_b
);

-- Prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair
  ON friendships(user_id_a, user_id_b);

COMMIT;
