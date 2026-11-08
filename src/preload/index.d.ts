import type { ShipWardenApi } from '../shared/api';

declare global {
    interface Window {
        shipwarden: ShipWardenApi;
    }
}
