ALTER TABLE bookings
    ADD COLUMN privacy_consent_at TIMESTAMPTZ;

ALTER TABLE inquiries
    ADD COLUMN privacy_consent_at TIMESTAMPTZ;

ALTER TABLE applications
    ADD COLUMN privacy_consent_at TIMESTAMPTZ;
