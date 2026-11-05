<?php
/**
 * Plugin Name:       QCS Ghana Shipping
 * Plugin URI:        https://qcsghana.com
 * Description:       QCS Ghana delivery for WooCommerce: live prices at checkout, deliveries booked automatically when orders are paid, and status updates on your orders.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            QCS Ghana (Quality Courier Services)
 * License:           GPL-2.0-or-later
 * Text Domain:       qcs-ghana
 * WC requires at least: 8.0
 */
defined( 'ABSPATH' ) || exit;

define( 'QCS_GHANA_VERSION', '1.0.0' );
define( 'QCS_GHANA_DIR', __DIR__ );

require_once QCS_GHANA_DIR . '/includes/class-qcs-helpers.php';
require_once QCS_GHANA_DIR . '/includes/class-qcs-api.php';
require_once QCS_GHANA_DIR . '/includes/class-qcs-orders.php';
require_once QCS_GHANA_DIR . '/includes/class-qcs-webhook.php';

// Works with WooCommerce's newer order storage (HPOS).
add_action( 'before_woocommerce_init', function () {
	if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
	}
} );

add_action( 'woocommerce_shipping_init', function () {
	require_once QCS_GHANA_DIR . '/includes/class-qcs-shipping-method.php';
} );
add_filter( 'woocommerce_shipping_methods', function ( $methods ) {
	$methods['qcs_ghana'] = 'QCS_Shipping_Method';
	return $methods;
} );

// Book the delivery once the order is paid (Processing). Cash-on-delivery orders also go to Processing.
add_action( 'woocommerce_order_status_processing', array( 'QCS_Orders', 'maybe_book' ) );
add_action( 'woocommerce_payment_complete', array( 'QCS_Orders', 'maybe_book' ) );
add_filter( 'woocommerce_order_actions', array( 'QCS_Orders', 'order_action' ) );
add_action( 'woocommerce_order_action_qcs_book', array( 'QCS_Orders', 'book_from_action' ) );
add_action( 'add_meta_boxes', array( 'QCS_Orders', 'meta_box' ) );

// Status updates from QCS: https://your-shop/wp-json/qcs/v1/webhook
add_action( 'rest_api_init', array( 'QCS_Webhook', 'register' ) );

// "Test connection" button on the settings page.
add_action( 'wp_ajax_qcs_test_connection', function () {
	check_ajax_referer( 'qcs_test', 'nonce' );
	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		wp_send_json_error( 'Not allowed', 403 );
	}
	$r = QCS_Api::request( 'GET', '/me' );
	if ( $r['ok'] ) {
		wp_send_json_success( sprintf( 'Connected to %s (%s mode)%s', $r['body']['business'], $r['body']['mode'], $r['body']['has_default_pickup'] ? '' : ' — set a default pickup address in the QCS portal' ) );
	}
	wp_send_json_error( $r['error'] );
} );

add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), function ( $links ) {
	array_unshift( $links, '<a href="' . esc_url( admin_url( 'admin.php?page=wc-settings&tab=shipping&section=qcs_ghana' ) ) . '">Settings</a>' );
	return $links;
} );
