import * as sessionManager from "./sessionManager";
import type {
  RoomDocument as CliRoomDocument,
  RoomSessionResult as CliRoomSessionResult,
} from "../cliRunner";

export type RoomDocument = CliRoomDocument;
export type RoomSessionResult = CliRoomSessionResult;

export const createOrUseSession = sessionManager.createOrUseSession;
export const closeSessionByDocId = sessionManager.closeSessionByDocId;
export const closeAllSessions = sessionManager.closeAllSessions;
export const ensureYjsRoom = sessionManager.ensureYjsRoom;
export const saveSessionDocument = sessionManager.saveSessionDocument;
export const saveSessionDocuments = sessionManager.saveSessionDocuments;
