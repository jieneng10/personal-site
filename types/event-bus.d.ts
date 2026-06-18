// ==================== EventBus types ====================

declare module 'event-bus.mjs' {
  export interface EventBus {
    on(event: string, fn: (data?: any) => void): void;
    off(event: string, fn: (data?: any) => void): void;
    emit(event: string, data?: any): void;
  }
  export const EventBus: EventBus;
  export const on: EventBus['on'];
  export const off: EventBus['off'];
  export const emit: EventBus['emit'];
}
