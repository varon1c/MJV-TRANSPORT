CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_confirmed_overlap
    EXCLUDE USING gist (
        vehicle_id WITH =,
        tstzrange(pickup_at, return_at, '[)') WITH &&
    )
    WHERE (status = 'confirmed');
