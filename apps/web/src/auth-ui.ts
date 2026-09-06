import type { AuthRole, AuthUserResponse } from "@zima-control-center/application-registry-contracts";
import { AuthApiError, type AuthApiClient } from "./auth-api.js";

export function renderAuthenticationLoading(root: HTMLElement): void {
  const document = root.ownerDocument;
  const main = document.createElement("main");
  main.className = "auth-page";
  main.setAttribute("aria-busy", "true");
  const panel = document.createElement("section");
  panel.className = "auth-card state-panel loading-state";
  panel.setAttribute("role", "status");
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  const message = document.createElement("p");
  message.textContent = "Checking authentication";
  panel.append(spinner, message);
  main.append(panel);
  root.replaceChildren(main);
}

export function renderAuthenticationUnavailable(
  root: HTMLElement,
  retry: () => void,
): void {
  const document = root.ownerDocument;
  const main = document.createElement("main");
  main.className = "auth-page";
  const panel = document.createElement("section");
  panel.className = "auth-card state-panel error-state";
  panel.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = "Authentication unavailable";
  const message = document.createElement("p");
  message.textContent = "The control center could not verify your session. Try again shortly.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button";
  button.textContent = "Retry";
  button.addEventListener("click", retry);
  panel.append(heading, message, button);
  main.append(panel);
  root.replaceChildren(main);
}

export function renderLoginPage(
  root: HTMLElement,
  auth: AuthApiClient,
  onAuthenticated: (user: AuthUserResponse) => void,
): void {
  const document = root.ownerDocument;
  const main = document.createElement("main");
  main.className = "auth-page";
  const panel = document.createElement("section");
  panel.className = "auth-card";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Zima Control Center";
  const heading = document.createElement("h1");
  heading.textContent = "Sign in";
  const description = document.createElement("p");
  description.className = "page-description";
  description.textContent = "Authenticate to view the application registry.";

  const form = document.createElement("form");
  form.className = "auth-form";
  form.noValidate = true;
  const error = document.createElement("p");
  error.className = "auth-error";
  error.setAttribute("role", "alert");
  error.hidden = true;

  const username = input(document, "Username", "username", "username");
  const password = input(document, "Password", "password", "current-password");
  password.control.type = "password";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button auth-submit";
  submit.textContent = "Sign in";

  form.append(username.wrapper, password.wrapper, error, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    void auth.login(username.control.value, password.control.value)
      .then(onAuthenticated)
      .catch((reason: unknown) => {
        error.textContent = safeLoginMessage(reason);
        error.hidden = false;
        submit.disabled = false;
        password.control.value = "";
        password.control.focus();
      });
  });

  panel.append(eyebrow, heading, description, form);
  main.append(panel);
  root.replaceChildren(main);
  username.control.focus();
}

export function addAuthenticatedUserControls(
  root: HTMLElement,
  user: AuthUserResponse,
  onLogout: () => Promise<void>,
): void {
  const header = root.querySelector<HTMLElement>(".topbar");
  if (!header) {
    return;
  }
  const document = root.ownerDocument;
  const controls = document.createElement("div");
  controls.className = "auth-controls";
  const identity = document.createElement("span");
  identity.className = "auth-identity";
  identity.textContent = `${user.username} · ${roleLabel(user.role)}`;
  const error = document.createElement("span");
  error.className = "auth-control-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-quiet";
  button.textContent = "Sign out";
  button.addEventListener("click", () => {
    button.disabled = true;
    error.hidden = true;
    void onLogout().catch((reason: unknown) => {
      error.textContent = reason instanceof AuthApiError
        ? reason.message
        : "Sign out was not completed";
      error.hidden = false;
      button.disabled = false;
    });
  });
  controls.append(identity, error, button);
  const environment = header.querySelector<HTMLElement>(".environment-chip");
  if (environment) {
    environment.replaceWith(controls);
  } else {
    header.append(controls);
  }
}

function input(
  document: Document,
  labelText: string,
  id: string,
  autocomplete: string,
): { wrapper: HTMLElement; control: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "field-label";
  label.htmlFor = id;
  label.textContent = labelText;
  const control = document.createElement("input");
  control.id = id;
  control.className = "control";
  control.required = true;
  control.setAttribute("autocomplete", autocomplete);
  const wrapper = document.createElement("div");
  wrapper.className = "field";
  wrapper.append(label, control);
  return { wrapper, control };
}

function safeLoginMessage(reason: unknown): string {
  if (reason instanceof AuthApiError) {
    switch (reason.code) {
      case "INVALID_CREDENTIALS":
        return "Invalid username or password.";
      case "THROTTLED":
        return "Sign-in is temporarily unavailable. Try again later.";
      case "UNAVAILABLE":
        return "Sign-in is unavailable. Try again later.";
      default:
        return "Sign-in could not be completed.";
    }
  }
  return "Sign-in could not be completed.";
}

export function roleLabel(role: AuthRole): string {
  return role.charAt(0) + role.slice(1).toLocaleLowerCase();
}
