-- a rider's phone sends its position
\set r random(1, 1500)
select loadtest.ping(:r);
