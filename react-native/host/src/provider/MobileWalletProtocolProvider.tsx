import { createContext, ReactNode, useCallback, useMemo, useState } from 'react';

import { HandshakeAction, isHandshakeAction, RequestAction } from '../action/action';
import { decodeRequest, decryptRequest } from '../request/decoding';
import {
  mapDecryptedContentToRequest,
  mapHandshakeToRequest,
  RequestMessage,
} from '../request/request';
import {
  ErrorValue,
  ResultValue,
  ReturnValue,
  sendError,
  sendResponse,
  shouldRespondToClient,
} from '../response/response';
import { createSession } from '../sessions/createSession';
import {
  addSession,
  deleteSessions,
  getSession,
  getSessions,
  isSessionValid,
  SecureStorage,
} from '../sessions/sessions';
import { AppMetadata, fetchClientAppMetadata } from '../utils/fetchClientAppMetadata';
import { isClientAppVerified } from '../utils/isClientAppVerified';
import React from 'react';
import { emitEvent } from '../events/events';

type MWPHostContextType = {
  message: RequestMessage | null;
  handleRequestUrl: (url: string) => Promise<boolean>;
  fetchClientAppMetadata: () => Promise<AppMetadata | null>;
  isClientAppVerified: () => Promise<boolean>;
  approveHandshake: (action: HandshakeAction, metadata: AppMetadata) => Promise<void>;
  rejectHandshake: (description: string) => Promise<void>;
  approveAction: (action: RequestAction, result: ResultValue) => Promise<void>;
  rejectAction: (action: RequestAction, error: ErrorValue) => Promise<void>;
};

type MWPHostProviderProps = {
  secureStorage: SecureStorage;
  sessionExpiryDays: number;
  children?: ReactNode;
};

let prevRequestUUID: string | null = null;
const actionToResponseMap = new Map<number, ReturnValue>();

export const MobileWalletProtocolContext = createContext<MWPHostContextType | null>(null);

export function MobileWalletProtocolProvider({
  children,
  secureStorage,
  sessionExpiryDays,
}: MWPHostProviderProps) {
  const [activeMessage, setActiveMessage] = useState<RequestMessage | null>(null);

  const updateActiveMessage = useCallback((message: RequestMessage | null) => {
    actionToResponseMap.clear();
    setActiveMessage(message);
  }, []);

  const handleRequestUrl = useCallback(
    async (url: string): Promise<boolean> => {
      const decoded = await decodeRequest(url);
      if (!decoded) {
        return false;
      }

      if (prevRequestUUID === decoded.uuid) {
        return false;
      }
      prevRequestUUID = decoded.uuid;

      if ('handshake' in decoded.content) {
        const message = mapHandshakeToRequest(decoded.content.handshake, decoded);
        updateActiveMessage(message);
        return true;
      }

      if ('request' in decoded.content) {
        const session = await getSession(secureStorage, decoded);
        if (!session) {
          emitEvent({
            name: 'session_not_found',
            params: { callbackUrl: decoded.callbackUrl },
          });

          await sendError(
            'Session not found. Please initiate a handshake request prior to making a request',
            decoded,
          );
          return false;
        }

        if (!isSessionValid(session, sessionExpiryDays)) {
          emitEvent({
            name: 'session_expired',
            params: {
              appName: session.dappName,
              appId: session.dappId,
              callbackUrl: session.dappURL,
            },
          });

          await deleteSessions(secureStorage, [session]);
          await sendError(
            'Session expired. Please initiate another handshake request to connect.',
            decoded,
          );
          return false;
        }

        const decrypted = await decryptRequest(url, session);
        const message = mapDecryptedContentToRequest(decrypted.content.request, decoded);
        updateActiveMessage(message);
        return true;
      }

      return false;
    },
    [secureStorage, sessionExpiryDays, updateActiveMessage],
  );

  const fetchAppMetadata = useCallback(async () => {
    const handshake = activeMessage?.actions.find(isHandshakeAction);
    if (!handshake) {
      throw new Error('No handshake action');
    }

    return fetchClientAppMetadata({
      appId: handshake.appId,
      appUrl: handshake.callback,
    });
  }, [activeMessage?.actions]);

  const isAppVerified = useCallback(async () => {
    const handshake = activeMessage?.actions.find(isHandshakeAction);
    if (!handshake) {
      throw new Error('No handshake action');
    }

    return isClientAppVerified({
      appId: handshake.appId,
      callbackUrl: handshake.callback,
    });
  }, [activeMessage?.actions]);

  const approveHandshake = useCallback(
    async (action: HandshakeAction, metadata: AppMetadata) => {
      if (!activeMessage) {
        throw new Error('No message found');
      }

      const session = await createSession(metadata, action, activeMessage);
      const sessions = await getSessions(secureStorage);

      // Delete existing session if it matches the app id
      const existingSession = sessions.find((value) => value.dappId === metadata.appId);
      if (existingSession) {
        await deleteSessions(secureStorage, [existingSession]);
      }

      await addSession(secureStorage, session);

      if (shouldRespondToClient(actionToResponseMap, activeMessage)) {
        await sendResponse(actionToResponseMap, activeMessage, secureStorage);
        updateActiveMessage(null);
      }
    },
    [activeMessage, secureStorage, updateActiveMessage],
  );

  const rejectHandshake = useCallback(
    async (description: string) => {
      if (!activeMessage) {
        throw new Error('No message found');
      }

      await sendError(description, activeMessage);
      updateActiveMessage(null);
    },
    [activeMessage, updateActiveMessage],
  );

  const approveAction = useCallback(
    async (action: RequestAction, result: ResultValue) => {
      if (!activeMessage) {
        throw new Error('No message found');
      }

      actionToResponseMap.set(action.id, { result });

      if (shouldRespondToClient(actionToResponseMap, activeMessage)) {
        await sendResponse(actionToResponseMap, activeMessage, secureStorage);
        updateActiveMessage(null);
      }
    },
    [activeMessage, secureStorage, updateActiveMessage],
  );

  const rejectAction = useCallback(
    async (action: RequestAction, error: ErrorValue) => {
      if (!activeMessage) {
        throw new Error('No message found');
      }

      actionToResponseMap.set(action.id, { error });

      if (action.optional) {
        if (shouldRespondToClient(actionToResponseMap, activeMessage)) {
          await sendResponse(actionToResponseMap, activeMessage, secureStorage);
          updateActiveMessage(null);
        }
      } else {
        await sendResponse(actionToResponseMap, activeMessage, secureStorage);
      }
    },
    [activeMessage, secureStorage, updateActiveMessage],
  );

  const value = useMemo(() => {
    return {
      message: activeMessage,
      handleRequestUrl,
      approveHandshake,
      rejectHandshake,
      approveAction,
      rejectAction,
      fetchClientAppMetadata: fetchAppMetadata,
      isClientAppVerified: isAppVerified,
    };
  }, [
    activeMessage,
    approveAction,
    approveHandshake,
    fetchAppMetadata,
    handleRequestUrl,
    isAppVerified,
    rejectAction,
    rejectHandshake,
  ]);

  return (
    <MobileWalletProtocolContext.Provider value={value}>
      {children}
    </MobileWalletProtocolContext.Provider>
  );
}
