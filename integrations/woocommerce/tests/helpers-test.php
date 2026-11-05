<?php
// Plain PHP tests for the plugin helpers: php integrations/woocommerce/tests/helpers-test.php
define( 'QCS_TESTING', true );
require __DIR__ . '/../qcs-ghana-shipping/includes/class-qcs-helpers.php';

$fails = 0;
function check( $cond, $label ) {
	global $fails;
	if ( $cond ) { echo "ok  $label\n"; } else { echo "FAIL $label\n"; $fails++; }
}

// signature: same recipe as the QCS docs and the sender (known answer shared with the Deno test)
$h = 't=1700000000,v1=3b843bacfb18cc5554542fdcc84d815b399c52758e508a6fcecf0a2af4efea2b';
check( QCS_Helpers::verify_signature( '{"a":1}', $h, 'whsec_abc', 1700000100 ), 'valid signature accepted' );
check( ! QCS_Helpers::verify_signature( '{"a":2}', $h, 'whsec_abc', 1700000100 ), 'changed body refused' );
check( ! QCS_Helpers::verify_signature( '{"a":1}', $h, 'whsec_other', 1700000100 ), 'wrong secret refused' );
check( ! QCS_Helpers::verify_signature( '{"a":1}', $h, 'whsec_abc', 1700000400 ), 'older than 5 minutes refused (replay)' );
check( ! QCS_Helpers::verify_signature( '{"a":1}', '', 'whsec_abc' ), 'missing header refused' );
check( ! QCS_Helpers::verify_signature( '{"a":1}', $h, '' ), 'missing secret refused' );

check( 1500 === QCS_Helpers::to_grams( '1.5', 'kg' ) && 454 === QCS_Helpers::to_grams( 1, 'lbs' ) && 250 === QCS_Helpers::to_grams( 250, 'g' ), 'weights to grams' );
check( 1000 === QCS_Helpers::parcel_grams( 0 ) && 100 === QCS_Helpers::parcel_grams( 20 ) && 30000 === QCS_Helpers::parcel_grams( 99999 ), 'parcel weight limits' );

$r = QCS_Helpers::rates_payload( array( 'address_1' => '', 'city' => 'Kumasi', 'state' => 'AH' ), 2400, 'ecommerce' );
check( 'Kumasi' === $r['dropoff']['address'] && 2400 === $r['parcel']['weight_g'] && ! isset( $r['service'] ), 'rates request: city only, no service = all services' );

$order = array(
	'number' => '1042', 'first_name' => 'Esi', 'last_name' => 'Mensah', 'address_1' => '12 Lagos Ave', 'address_2' => 'East Legon',
	'city' => 'Accra', 'state' => 'Greater Accra', 'phone' => '0243334444', 'note' => 'Call before coming',
	'items' => array( array( 'name' => 'Kente dress', 'qty' => 2, 'grams' => 600 ) ), 'subtotal' => '250.00', 'total' => '275.50',
	'currency' => 'GHS', 'payment_method' => 'cod', 'service' => 'intercity', 'intercity_option' => 'hub_collection',
);
$p = QCS_Helpers::delivery_payload( $order );
check( '1042' === $p['reference'] && 'Esi Mensah' === $p['dropoff']['contact_name'] && '12 Lagos Ave, East Legon' === $p['dropoff']['address'], 'order: reference, name, address' );
check( 1200 === $p['parcel']['weight_g'] && '2× Kente dress' === $p['parcel']['description'], 'order: weight and contents' );
check( 25000 === $p['parcel']['value'] && 27550 === $p['parcel']['cod_amount'], 'order: value and COD in pesewas' );
check( 'intercity' === $p['service'] && 'hub_collection' === $p['intercity_option'], 'order: chosen inter-city option' );
$order['payment_method'] = 'hubtel';
$order['currency']       = 'USD';
$p2 = QCS_Helpers::delivery_payload( $order );
check( 0 === $p2['parcel']['cod_amount'] && 0 === $p2['parcel']['value'], 'paid online / foreign currency: no COD, no value' );
check( 'intercity:doorstep' === QCS_Helpers::rate_code( array( 'service' => 'intercity', 'intercity_option' => 'doorstep' ) ), 'rate code' );
check( 'QCS: Delivery attempt failed (recipient unreachable) — ACC-1' === QCS_Helpers::status_note( array( 'status_text' => 'Delivery attempt failed', 'reason' => 'recipient_unreachable', 'tracking_number' => 'ACC-1' ) ), 'order note text' );

echo $fails ? "\n$fails FAILED\n" : "\nAll plugin helper tests passed\n";
exit( $fails ? 1 : 0 );
