<?php
/** "QCS Ghana" shipping method: live prices at checkout from the QCS pricing engine. */
defined( 'ABSPATH' ) || exit;

class QCS_Shipping_Method extends WC_Shipping_Method {

	public function __construct( $instance_id = 0 ) {
		$this->id                 = 'qcs_ghana';
		$this->instance_id        = absint( $instance_id );
		$this->method_title       = 'QCS Ghana';
		$this->method_description = 'Same-day delivery in Accra, Kumasi, Takoradi and Tamale, and inter-city by bus between QCS hubs. Prices come live from QCS.';
		$this->supports           = array( 'shipping-zones', 'settings' );
		$this->init();
	}

	public function init() {
		$this->init_form_fields();
		$this->init_settings();
		$this->enabled = $this->get_option( 'enabled', 'yes' );
		$this->title   = $this->get_option( 'title', 'QCS Ghana' );
		add_action( 'woocommerce_update_options_shipping_' . $this->id, array( $this, 'process_admin_options' ) );
	}

	public function init_form_fields() {
		$webhook = rest_url( 'qcs/v1/webhook' );
		$this->form_fields = array(
			'enabled'               => array( 'title' => 'Enable', 'type' => 'checkbox', 'label' => 'Offer QCS delivery at checkout', 'default' => 'yes' ),
			'title'                 => array( 'title' => 'Name at checkout', 'type' => 'text', 'default' => 'QCS Ghana' ),
			'api_key'               => array( 'title' => 'API key', 'type' => 'password', 'description' => 'From the QCS business portal → Developers. Start with a test key (qcs_test_…).' ),
			'service'               => array( 'title' => 'Service', 'type' => 'select', 'default' => 'ecommerce',
				'options' => array( 'ecommerce' => 'Same-day delivery (and inter-city for other cities)', 'express' => 'Express — a rider comes now (Accra/Kumasi/Takoradi/Tamale)' ) ),
			'auto_book'             => array( 'title' => 'Book automatically', 'type' => 'checkbox', 'label' => 'Book a QCS delivery when an order with QCS shipping is paid (Processing)', 'default' => 'yes' ),
			'webhook_secret'        => array( 'title' => 'Webhook signing secret', 'type' => 'password',
				'description' => 'For status updates on your orders: in the QCS portal → Developers → Webhooks add <code>' . esc_html( $webhook ) . '</code> and paste its secret (whsec_…) here.' ),
			'complete_on_delivered' => array( 'title' => 'Complete orders', 'type' => 'checkbox', 'label' => 'Mark the order Completed when QCS delivers it', 'default' => 'yes' ),
			'api_base'              => array( 'title' => 'API address', 'type' => 'text', 'default' => QCS_Api::DEFAULT_BASE, 'description' => 'Leave as it is unless QCS tells you otherwise.' ),
		);
	}

	public function admin_options() {
		parent::admin_options();
		$nonce = wp_create_nonce( 'qcs_test' );
		echo '<p><button type="button" class="button" id="qcs-test">Test connection</button> <span id="qcs-test-result"></span></p>';
		echo '<script>document.getElementById("qcs-test").addEventListener("click",function(){var o=document.getElementById("qcs-test-result");o.textContent="Checking…";'
			. 'fetch(ajaxurl+"?action=qcs_test_connection&nonce=' . esc_js( $nonce ) . '",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(j){o.textContent=(j.success?"✓ ":"✗ ")+j.data;});});</script>';
	}

	/** Weight of the cart in grams. */
	private function package_grams( $package ) {
		$grams = 0;
		foreach ( $package['contents'] as $item ) {
			$product = $item['data'];
			if ( $product && $product->needs_shipping() ) {
				$grams += QCS_Helpers::to_grams( (float) $product->get_weight(), get_option( 'woocommerce_weight_unit' ) ) * (int) $item['quantity'];
			}
		}
		return $grams;
	}

	public function calculate_shipping( $package = array() ) {
		$dest = $package['destination'];
		if ( 'GH' !== $dest['country'] || 'GHS' !== get_woocommerce_currency() ) {
			return;   // QCS delivers in Ghana and prices in cedis
		}
		$payload = QCS_Helpers::rates_payload( $dest, $this->package_grams( $package ), $this->get_option( 'service', 'ecommerce' ) );
		$cache   = 'qcs_rates_' . md5( wp_json_encode( $payload ) . $this->get_option( 'api_key' ) );
		$rates   = get_transient( $cache );
		if ( false === $rates ) {
			$r = QCS_Api::request( 'POST', '/rates', $payload, null, 8 );   // keep checkout fast
			if ( ! $r['ok'] ) {
				if ( 422 !== $r['status'] ) {
					wc_get_logger()->warning( 'QCS rates: ' . $r['error'], array( 'source' => 'qcs-ghana' ) );
				}
				return;
			}
			$rates = $r['body']['rates'];
			set_transient( $cache, $rates, 10 * MINUTE_IN_SECONDS );
		}
		foreach ( $rates as $rate ) {
			$this->add_rate( array(
				'id'        => $this->get_rate_id( QCS_Helpers::rate_code( $rate ) ),
				'label'     => $rate['name'],
				'cost'      => $rate['amount'] / 100,
				'meta_data' => array( 'qcs_service' => $rate['service'], 'qcs_intercity_option' => isset( $rate['intercity_option'] ) ? $rate['intercity_option'] : '' ),
			) );
		}
	}
}
