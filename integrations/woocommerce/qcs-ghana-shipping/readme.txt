=== QCS Ghana Shipping ===
Contributors: qcsghana
Tags: shipping, delivery, ghana, courier, cash on delivery
Requires at least: 6.0
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Deliver your WooCommerce orders with QCS Ghana: live prices at checkout, automatic booking, status updates on your orders.

== Description ==
* Live QCS prices at checkout (same-day in Accra, Kumasi, Takoradi and Tamale; inter-city by bus to 20+ cities).
* When an order with QCS shipping is paid (Processing), the delivery is booked automatically and the tracking number is added to the order.
* Cash on delivery orders send the order total as COD: the rider collects it and QCS pays it out to you.
* Status updates (picked up, delivered, failed attempt…) appear as order notes; delivered orders can be completed automatically.

== Installation ==
1. Upload the zip (Plugins → Add New → Upload Plugin) and activate.
2. WooCommerce → Settings → Shipping → QCS Ghana: paste your API key from the QCS business portal (Developers), press Test connection.
3. Add "QCS Ghana" to a shipping zone that covers Ghana. Your store currency must be Ghana cedi (GHS).
4. Optional, for status updates: in the QCS portal → Developers → Webhooks add the address shown in the settings and paste its secret.

Use a test key (qcs_test_…) first: deliveries are practice only. Switch to a live key when you're ready.

== Changelog ==
= 1.0.0 =
* First release.
