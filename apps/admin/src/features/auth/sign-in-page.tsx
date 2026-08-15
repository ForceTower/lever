import { CircleNotchIcon, FingerprintIcon, LockKeyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { BrandLockup } from "@/components/brand-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/auth-context";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/queries";

type Mode = "sign-in" | "enroll";

/**
 * The only screen reachable without a session. Both ceremonies live here
 * because they are the same act from the operator's side — prove it is you on
 * this device — and because a fresh deployment has no other way in: the
 * enrollment code from `admin:enroll` is exchanged for a passkey right here.
 */
export function SignInPage() {
  const { signIn } = useAuth();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");

  const run = async (ceremony: Promise<Awaited<ReturnType<typeof api.auth.login>>>) => {
    setWaiting(true);
    setError("");
    try {
      signIn(await ceremony);
    } catch (thrown) {
      // A cancelled platform prompt throws too; the message says which it was.
      setError(errorMessage(thrown));
    } finally {
      setWaiting(false);
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (waiting) return;
    void run(
      mode === "sign-in"
        ? api.auth.login()
        : api.auth.register(code.trim(), deviceName.trim() || "This device"),
    );
  };

  return (
    <div className="flex min-h-svh flex-col">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>
      <div className="flex flex-1 items-center justify-center px-6 pb-24">
        <div className="animate-lever-in flex w-full max-w-100 flex-col gap-5.5">
          <div className="flex flex-col gap-2">
            <BrandLockup className="text-[17px]" />
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Self-hosted remote config. Sign in with the passkey registered on this deployment.
            </p>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-2.5">
            {mode === "enroll" && (
              <div className="flex flex-col gap-3 pb-1">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="code">Enrollment code</Label>
                  <Input
                    id="code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    placeholder="printed by admin:enroll"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="device">Name this device</Label>
                  <Input
                    id="device"
                    value={deviceName}
                    onChange={(event) => setDeviceName(event.target.value)}
                    placeholder="Work laptop"
                  />
                </div>
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              disabled={waiting || (mode === "enroll" && !code.trim())}
            >
              {waiting ? (
                <CircleNotchIcon className="animate-spin" />
              ) : (
                <FingerprintIcon className="size-[17px]" />
              )}
              {waiting
                ? "Waiting for your passkey"
                : mode === "sign-in"
                  ? "Sign in with a passkey"
                  : "Register this device"}
            </Button>

            {error !== "" && <p className="text-[12.5px] leading-relaxed text-del">{error}</p>}

            <Button
              type="button"
              variant="link"
              size="sm"
              className="self-start px-0 text-muted-foreground"
              onClick={() => {
                setMode(mode === "sign-in" ? "enroll" : "sign-in");
                setError("");
              }}
            >
              {mode === "sign-in" ? "Have an enrollment code?" : "Back to sign in"}
            </Button>
          </form>

          <Alert variant="muted">
            <LockKeyIcon />
            <AlertDescription className="text-[12.5px] leading-relaxed">
              The passkey never leaves your device — there is no password to store and nothing to
              paste. A 401 anywhere returns you to this screen. Register a second passkey on another
              device so a lost phone does not lock you out mid-incident.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    </div>
  );
}
