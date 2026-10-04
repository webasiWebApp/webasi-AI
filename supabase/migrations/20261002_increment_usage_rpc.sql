-- Atomic usage counter increment to avoid read-modify-write races.
CREATE OR REPLACE FUNCTION increment_usage_counter(p_period text, p_column text)
RETURNS void AS $$
BEGIN
  IF p_column = 'outbound_whatsapp' THEN
    INSERT INTO usage_counters (period_key, outbound_whatsapp, gemini_requests, updated_at)
    VALUES (p_period, 1, 0, now())
    ON CONFLICT (period_key)
    DO UPDATE SET outbound_whatsapp = usage_counters.outbound_whatsapp + 1, updated_at = now();
  ELSIF p_column = 'gemini_requests' THEN
    INSERT INTO usage_counters (period_key, outbound_whatsapp, gemini_requests, updated_at)
    VALUES (p_period, 0, 1, now())
    ON CONFLICT (period_key)
    DO UPDATE SET gemini_requests = usage_counters.gemini_requests + 1, updated_at = now();
  END IF;
END;
$$ LANGUAGE plpgsql;
