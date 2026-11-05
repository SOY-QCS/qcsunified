<?php
/**
 * Pure helpers (no WordPress calls) so they can be tested on their own: tests/helpers-test.php.
 */
defined( 'QCS_TESTING' ) || defined( 'ABSPATH' ) || exit;

class QCS_Helpers {

	/** Check the QCS-Signature header: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>, max 5 minutes old. */
	public static function verify_signature( $raw_body, $header, $secret, $now = null ) {
		if ( ! is_string( $header ) || '' === $header || ! is_string( $secret ) || '' === $secret ) {
			return false;
		}
		$parts = array();
		foreach ( explode( ',', $header ) as $piece ) {
			$kv = explode( '=', trim( $piece ), 2 );
			if ( 2 === count( $kv ) ) {
				$parts[ $kv[0] ] = $kv[1];
			}
		}
		$t  = isset( $parts['t'] ) ? (int) $parts['t'] : 0;
		$v1 = isset( $parts['v1'] ) ? $parts['v1'] : '';
		$now = null === $now ? time() : $now;
		if ( $t <= 0 || abs( $now - $t ) > 300 || 64 !== strlen( $v1 ) ) {
			return false;
		}
		return hash_equals( hash_hmac( 'sha256', $t . '.' . $raw_body, $secret ), $v1 );
	}

	/** WooCommerce weight in the shop's unit → grams. */
	public static function to_grams( $weight, $unit ) {
		$w = (float) $weight;
		switch ( $unit ) {
			case 'kg':
				return (int) round( $w * 1000 );
			case 'lbs':
				return (int) round( $w * 453.592 );
			case 'oz':
				return (int) round( $w * 28.3495 );
			default:
				return (int) round( $w );
		}
	}

	/** Weight we send: at least 100 g, at most 30 kg, 1 kg when the products have no weight. */
	public static function parcel_grams( $grams ) {
		$g = (int) $grams;
		if ( $g <= 0 ) {
			return 1000;
		}
		return max( 100, min( 30000, $g ) );
	}

	/** Money in the shop's currency → pesewas (only meaningful for GHS shops). */
	public static function pesewas( $amount ) {
		return (int) round( (float) $amount * 100 );
	}

	/** Price check for the checkout page. */
	public static function rates_payload( array $dest, $grams, $service ) {
		$address = trim( implode( ', ', array_filter( array( isset( $dest['address_1'] ) ? $dest['address_1'] : '', isset( $dest['address_2'] ) ? $dest['address_2'] : '' ) ) ) );
		$city    = isset( $dest['city'] ) ? trim( $dest['city'] ) : '';
		$payload = array(
			'dropoff' => array(
				'address' => '' !== $address ? $address : ( '' !== $city ? $city : 'Ghana' ),
				'city'    => '' !== $city ? $city : null,
				'region'  => isset( $dest['state'] ) && '' !== $dest['state'] ? $dest['state'] : null,
			),
			'parcel'  => array( 'weight_g' => self::parcel_grams( $grams ) ),
		);
		if ( 'express' === $service ) {
			$payload['service'] = 'express';
		}
		return $payload;
	}

	/**
	 * A paid WooCommerce order → QCS delivery request.
	 * $o: number, first_name, last_name, address_1, address_2, city, state, phone, note, items[name, qty, grams],
	 *     subtotal, total, currency, payment_method, service, intercity_option
	 */
	public static function delivery_payload( array $o ) {
		$ghs   = 'GHS' === $o['currency'];
		$grams = 0;
		$names = array();
		foreach ( $o['items'] as $it ) {
			$grams  += (int) $it['grams'] * (int) $it['qty'];
			$names[] = (int) $it['qty'] . '× ' . $it['name'];
		}
		$address = trim( implode( ', ', array_filter( array( $o['address_1'], $o['address_2'] ) ) ) );
		$service = in_array( $o['service'], array( 'ecommerce', 'express', 'intercity' ), true ) ? $o['service'] : 'ecommerce';
		$payload = array(
			'service'   => $service,
			'reference' => substr( (string) $o['number'], 0, 80 ),
			'dropoff'   => array(
				'address'       => '' !== $address ? $address : ( '' !== $o['city'] ? $o['city'] : 'Ghana' ),
				'city'          => '' !== $o['city'] ? $o['city'] : null,
				'region'        => '' !== $o['state'] ? $o['state'] : null,
				'contact_name'  => substr( trim( $o['first_name'] . ' ' . $o['last_name'] ), 0, 120 ),
				'contact_phone' => $o['phone'],
				'instructions'  => '' !== (string) $o['note'] ? substr( (string) $o['note'], 0, 500 ) : null,
			),
			'parcel'    => array(
				'weight_g'    => self::parcel_grams( $grams ),
				'description' => '' !== implode( ', ', $names ) ? substr( implode( ', ', $names ), 0, 200 ) : null,
				'value'       => $ghs ? self::pesewas( $o['subtotal'] ) : 0,
				'cod_amount'  => ( $ghs && 'cod' === $o['payment_method'] ) ? self::pesewas( $o['total'] ) : 0,
			),
		);
		if ( 'intercity' === $service ) {
			$payload['intercity_option'] = 'hub_collection' === $o['intercity_option'] ? 'hub_collection' : 'doorstep';
		}
		return $payload;
	}

	/** Our rate code ↔ the WooCommerce rate id suffix, e.g. "intercity:doorstep". */
	public static function rate_code( array $rate ) {
		return empty( $rate['intercity_option'] ) ? $rate['service'] : $rate['service'] . ':' . $rate['intercity_option'];
	}

	/** Order note for a webhook event. */
	public static function status_note( array $data ) {
		$text = isset( $data['status_text'] ) ? $data['status_text'] : ( isset( $data['status'] ) ? $data['status'] : 'updated' );
		$note = 'QCS: ' . $text;
		if ( ! empty( $data['reason'] ) ) {
			$note .= ' (' . str_replace( '_', ' ', $data['reason'] ) . ')';
		}
		if ( ! empty( $data['tracking_number'] ) ) {
			$note .= ' — ' . $data['tracking_number'];
		}
		return $note;
	}
}
