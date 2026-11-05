<?php
/** Receives QCS status updates (signed) and writes them on the order. */
defined( 'ABSPATH' ) || exit;

class QCS_Webhook {

	public static function register() {
		register_rest_route( 'qcs/v1', '/webhook', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'handle' ),
			'permission_callback' => '__return_true',   // checked by signature below
		) );
	}

	public static function handle( WP_REST_Request $request ) {
		$raw = $request->get_body();
		if ( ! QCS_Helpers::verify_signature( $raw, $request->get_header( 'qcs_signature' ), (string) QCS_Api::setting( 'webhook_secret' ) ) ) {
			return new WP_REST_Response( array( 'error' => 'bad signature' ), 401 );
		}
		$event = json_decode( $raw, true );
		if ( ! is_array( $event ) || empty( $event['type'] ) ) {
			return new WP_REST_Response( array( 'error' => 'bad body' ), 400 );
		}
		if ( 'delivery.status_changed' !== $event['type'] ) {
			return new WP_REST_Response( array( 'ok' => true ), 200 );   // ping, delivery.created: nothing to do
		}
		$data   = $event['data'];
		$orders = wc_get_orders( array( 'limit' => 1, 'meta_key' => '_qcs_tracking', 'meta_value' => $data['tracking_number'] ) );   // phpcs:ignore WordPress.DB.SlowDBQuery
		if ( empty( $orders ) ) {
			return new WP_REST_Response( array( 'ok' => true, 'note' => 'unknown delivery' ), 200 );
		}
		$order = $orders[0];
		if ( $order->get_meta( '_qcs_last_event' ) === $event['id'] ) {
			return new WP_REST_Response( array( 'ok' => true, 'note' => 'repeat' ), 200 );   // QCS may send an event twice
		}
		$order->update_meta_data( '_qcs_last_event', $event['id'] );
		$order->update_meta_data( '_qcs_status', $data['status_text'] );
		$order->add_order_note( QCS_Helpers::status_note( $data ) );
		if ( in_array( $data['status'], array( 'DELIVERED', 'COLLECTED' ), true ) && 'yes' === QCS_Api::setting( 'complete_on_delivered', 'yes' ) && $order->has_status( 'processing' ) ) {
			$order->update_status( 'completed', 'Delivered by QCS.' );
		}
		$order->save();
		return new WP_REST_Response( array( 'ok' => true ), 200 );
	}
}
