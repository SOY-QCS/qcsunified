<?php
/** Books QCS deliveries for paid orders and shows the tracking number on the order. */
defined( 'ABSPATH' ) || exit;

class QCS_Orders {

	/** The QCS shipping line chosen at checkout, if any. */
	private static function qcs_line( $order ) {
		foreach ( $order->get_shipping_methods() as $line ) {
			if ( 'qcs_ghana' === $line->get_method_id() ) {
				return $line;
			}
		}
		return null;
	}

	public static function maybe_book( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || $order->get_meta( '_qcs_tracking' ) || 'yes' !== QCS_Api::setting( 'auto_book', 'yes' ) || ! self::qcs_line( $order ) ) {
			return;
		}
		self::book( $order );
	}

	public static function book( $order ) {
		$line  = self::qcs_line( $order );
		$items = array();
		foreach ( $order->get_items() as $item ) {
			$product = $item->get_product();
			if ( $product && ! $product->needs_shipping() ) {
				continue;
			}
			$items[] = array(
				'name'  => $item->get_name(),
				'qty'   => $item->get_quantity(),
				'grams' => $product ? QCS_Helpers::to_grams( (float) $product->get_weight(), get_option( 'woocommerce_weight_unit' ) ) : 0,
			);
		}
		$has_shipping = '' !== $order->get_shipping_address_1() || '' !== $order->get_shipping_city();
		$payload      = QCS_Helpers::delivery_payload( array(
			'number'           => $order->get_order_number(),
			'first_name'       => $has_shipping ? $order->get_shipping_first_name() : $order->get_billing_first_name(),
			'last_name'        => $has_shipping ? $order->get_shipping_last_name() : $order->get_billing_last_name(),
			'address_1'        => $has_shipping ? $order->get_shipping_address_1() : $order->get_billing_address_1(),
			'address_2'        => $has_shipping ? $order->get_shipping_address_2() : $order->get_billing_address_2(),
			'city'             => $has_shipping ? $order->get_shipping_city() : $order->get_billing_city(),
			'state'            => $has_shipping ? $order->get_shipping_state() : $order->get_billing_state(),
			'phone'            => $order->get_shipping_phone() ? $order->get_shipping_phone() : $order->get_billing_phone(),
			'note'             => $order->get_customer_note(),
			'items'            => $items,
			'subtotal'         => $order->get_subtotal(),
			'total'            => $order->get_total(),
			'currency'         => $order->get_currency(),
			'payment_method'   => $order->get_payment_method(),
			'service'          => $line ? $line->get_meta( 'qcs_service' ) : QCS_Api::setting( 'service', 'ecommerce' ),
			'intercity_option' => $line ? $line->get_meta( 'qcs_intercity_option' ) : '',
		) );
		// The same key on every retry: QCS never books an order twice.
		$r = QCS_Api::request( 'POST', '/deliveries', $payload, 'woo-' . substr( md5( home_url() ), 0, 8 ) . '-' . $order->get_id() );
		if ( $r['ok'] ) {
			$order->update_meta_data( '_qcs_tracking', $r['body']['tracking_number'] );
			$order->update_meta_data( '_qcs_tracking_url', $r['body']['tracking_url'] );
			$order->update_meta_data( '_qcs_status', $r['body']['status_text'] );
			$order->delete_meta_data( '_qcs_error' );
			$order->add_order_note( sprintf( 'QCS delivery booked: %s (%s). Track: %s', $r['body']['tracking_number'], $r['body']['livemode'] ? 'live' : 'TEST', $r['body']['tracking_url'] ) );
		} else {
			$order->update_meta_data( '_qcs_error', $r['error'] );
			$order->add_order_note( 'QCS delivery NOT booked: ' . $r['error'] . ' — fix it, then use Order actions → "Book QCS delivery".' );
		}
		$order->save();
		return $r['ok'];
	}

	public static function order_action( $actions ) {
		$actions['qcs_book'] = 'Book QCS delivery';
		return $actions;
	}

	public static function book_from_action( $order ) {
		if ( $order->get_meta( '_qcs_tracking' ) ) {
			$order->add_order_note( 'QCS: already booked as ' . $order->get_meta( '_qcs_tracking' ) );
			return;
		}
		self::book( $order );
	}

	public static function meta_box() {
		$screen = function_exists( 'wc_get_page_screen_id' ) ? wc_get_page_screen_id( 'shop-order' ) : 'shop_order';
		add_meta_box( 'qcs-ghana', 'QCS delivery', array( __CLASS__, 'render_box' ), $screen, 'side' );
	}

	public static function render_box( $post_or_order ) {
		$order = $post_or_order instanceof WC_Order ? $post_or_order : wc_get_order( $post_or_order->ID );
		$tn    = $order ? $order->get_meta( '_qcs_tracking' ) : '';
		if ( $tn ) {
			echo '<p><strong>' . esc_html( $tn ) . '</strong><br>' . esc_html( $order->get_meta( '_qcs_status' ) ) . '</p>';
			echo '<p><a href="' . esc_url( $order->get_meta( '_qcs_tracking_url' ) ) . '" target="_blank" rel="noopener">Track</a></p>';
		} elseif ( $order && $order->get_meta( '_qcs_error' ) ) {
			echo '<p style="color:#b32d2e">' . esc_html( $order->get_meta( '_qcs_error' ) ) . '</p><p>Use Order actions → "Book QCS delivery" to try again.</p>';
		} else {
			echo '<p>Not booked with QCS yet.</p>';
		}
	}
}
