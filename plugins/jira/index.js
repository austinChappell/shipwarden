// A ShipWarden task plugin for Jira Cloud. Each Jira project is a collection.
// The plugin uses the Jira Cloud REST API v3 with fetch. It has no dependencies.
// Node trusts the CA certificates of Settings › Network, because ShipWarden starts the plugin with NODE_EXTRA_CA_CERTS.
import { runPlugin } from '../sdk/index.js';
import { createHandlers } from './handlers.js';

runPlugin(createHandlers().handlers);
