-- someone opens the public tracking page
\set n random(1, 300000)
select loadtest.track(:n);
