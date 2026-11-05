<?php
/** Calls the QCS Business API with the key from the settings. */
defined( 'ABSPATH' ) || exit;

class QCS_Api {
	const DEFAULT_BASE = 'https://portal.qcsghana.com/api/business/v1';

	public static function settings() {
		$s = get_option( 'woocommerce_qcs_ghana_settings', array() );
		return is_array( $s ) ? $s : array();
	}

	public static function setting( $key, $default = '' ) {
		$s = self::settings();
		return isset( $s[ $key ] ) && '' !== $s[ $key ] ? $s[ $key ] : $default;
	}

	/**
	 * @return array{ok: bool, status: int, body: array, error: string}
	 */
	public static function request( $method, $path, $body = null, $idempotency_key = null, $timeout = 20 ) {
		$key = trim( (string) self::setting( 'api_key' ) );
		if ( ! preg_match( '/^qcs_(live|test)_[0-9a-f]{48}$/', $key ) ) {
			return array( 'ok' => false, 'status' => 0, 'body' => array(), 'error' => 'Add your QCS API key in WooCommerce → Settings → Shipping → QCS Ghana' );
		}
		$headers = array(
			'Authorization'   => 'Bearer ' . $key,
			'Content-Type'    => 'application/json',
			'QCS-Integration' => 'woocommerce',
			'User-Agent'      => 'QCS-WooCommerce/' . QCS_GHANA_VERSION . '; ' . home_url(),
		);
		if ( $idempotency_key ) {
			$headers['Idempotency-Key'] = $idempotency_key;
		}
		$res = wp_remote_request( rtrim( self::setting( 'api_base', self::DEFAULT_BASE ), '/' ) . $path, array(
			'method'  => $method,
			'headers' => $headers,
			'body'    => null === $body ? null : wp_json_encode( $body ),
			'timeout' => $timeout,
		) );
		if ( is_wp_error( $res ) ) {
			return array( 'ok' => false, 'status' => 0, 'body' => array(), 'error' => 'Could not reach QCS: ' . $res->get_error_message() );
		}
		$status = (int) wp_remote_retrieve_response_code( $res );
		$json   = json_decode( wp_remote_retrieve_body( $res ), true );
		$json   = is_array( $json ) ? $json : array();
		if ( $status >= 200 && $status < 300 ) {
			return array( 'ok' => true, 'status' => $status, 'body' => $json, 'error' => '' );
		}
		$err = isset( $json['error']['message'] ) ? $json['error']['message'] : 'HTTP ' . $status;
		if ( ! empty( $json['error']['details'] ) ) {
			$err .= ': ' . implode( '; ', (array) $json['error']['details'] );
		}
		return array( 'ok' => false, 'status' => $status, 'body' => $json, 'error' => $err );
	}
}
