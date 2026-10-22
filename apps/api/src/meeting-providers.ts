export type MeetingCaptureStatus = {
  provider: "GOOGLE_MEET";
  connected: boolean;
  status: "NOT_CONFIGURED" | "CONNECTED" | "ERROR";
  message: string;
};

export interface MeetingCaptureAdapter {
  status(): MeetingCaptureStatus;
  startCapture(input: { meetingUrl: string; implementationId: string }): Promise<{ externalMeetingId: string }>;
}

/**
 * Provider boundary for the first Google Meet pilot. Google OAuth and a
 * consent-aware meeting capture/bot service are intentionally required before
 * capture can be enabled; this adapter never pretends a bot has joined.
 */
export const googleMeetPilot: MeetingCaptureAdapter = {
  status: () => ({
    provider: "GOOGLE_MEET",
    connected: false,
    status: "NOT_CONFIGURED",
    message: "Google OAuth and a meeting-capture provider have not been configured for this local environment.",
  }),
  async startCapture() {
    throw new Error("MEETING_PROVIDER_NOT_CONFIGURED");
  },
};
