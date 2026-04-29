export interface BlazeITAPI {
  triggerComponentByName?: (name: string, event: string) => boolean | null;
  triggerHotspotByName?: (name: string, event: string) => boolean | null;
  getComponentByName?: (name: string) => unknown;
}
