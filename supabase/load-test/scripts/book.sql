-- a customer books an Express delivery (about 3 in 4 bookings) or a vendor books e-commerce
\set n random(1, 1000000)
select loadtest.book(:n, random() < 0.25);
