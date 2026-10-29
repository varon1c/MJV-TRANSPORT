INSERT INTO vehicles (name, model, category, description, capacity, image_path)
VALUES
    ('Manong Rentals', 'Toyota Hi-Ace Van', 'van', '12 passenger capacity.', 12, 'images/van.png'),
    ('Harold Rentals', 'Toyota Hi-Ace Van', 'van', '12 passenger capacity.', 12, 'images/van.png'),
    ('Jarvis Rentals', 'Toyota Hi-Ace Van', 'van', '12 passenger capacity.', 12, 'images/van.png')
ON CONFLICT (name) DO NOTHING;
