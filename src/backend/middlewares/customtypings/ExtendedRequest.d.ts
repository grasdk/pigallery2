/* eslint-disable @typescript-eslint/no-explicit-any */
import {LoginCredential} from '../../../common/entities/LoginCredential';
import {UserDTO} from '../../../common/entities/UserDTO';
import {SessionContext} from '../../model/SessionContext';

declare global {
  namespace Express {
    interface Request {
      // sending data between middlewares. Next middleware will expect the output of the previous one in this field.
      resultPipe?: unknown;
      body?: {
        loginCredential?: LoginCredential;
      };
      locale?: string;
      // Stored in the session cookie. Travels to the client side
      session: {
        context?: SessionContext;
        rememberMe?: boolean;
        oidc?: {
          state: string;
          verifier: string;
        }
      };
    }

    interface Response {
      tpl?: Record<string, any>;
    }

  }
}


