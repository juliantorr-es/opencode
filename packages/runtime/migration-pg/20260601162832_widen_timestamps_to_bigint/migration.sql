-- Widen JS-millisecond timestamp columns from integer to bigint.
-- Guards check pg_catalog before altering so this is safe to re-run.

-- coordination_claim
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'coordination_claim' AND column_name = 'created_at'
    AND data_type = 'integer'
  ) THEN
    ALTER TABLE coordination_claim ALTER COLUMN created_at SET DATA TYPE bigint USING created_at::bigint;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'coordination_claim' AND column_name = 'expires_at'
    AND data_type = 'integer'
  ) THEN
    ALTER TABLE coordination_claim ALTER COLUMN expires_at SET DATA TYPE bigint USING expires_at::bigint;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'coordination_claim' AND column_name = 'released_at'
    AND data_type = 'integer'
  ) THEN
    ALTER TABLE coordination_claim ALTER COLUMN released_at SET DATA TYPE bigint USING released_at::bigint;
  END IF;
END $$;

-- coordination_claim_action
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'coordination_claim_action' AND column_name = 'created_at'
    AND data_type = 'integer'
  ) THEN
    ALTER TABLE coordination_claim_action ALTER COLUMN created_at SET DATA TYPE bigint USING created_at::bigint;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'coordination_claim_action' AND column_name = 'expires_at'
    AND data_type = 'integer'
  ) THEN
    ALTER TABLE coordination_claim_action ALTER COLUMN expires_at SET DATA TYPE bigint USING expires_at::bigint;
  END IF;
END $$;

-- account
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'account' AND column_name = 'token_expiry'
    AND data_type = 'integer'
  ) THEN
    ALTER TABLE account ALTER COLUMN token_expiry SET DATA TYPE bigint USING token_expiry::bigint;
  END IF;
END $$;

-- control_account
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'control_account' AND column_name = 'token_expiry'
    AND data_type = 'integer'
  ) THEN
    ALTER TABLE control_account ALTER COLUMN token_expiry SET DATA TYPE bigint USING token_expiry::bigint;
  END IF;
END $$;
