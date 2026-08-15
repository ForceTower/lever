import { RouterProvider } from "@tanstack/react-router";
import { Providers } from "@/app/providers";
import { router } from "@/app/router";
import { useAuth } from "@/features/auth/auth-context";
import { SignInPage } from "@/features/auth/sign-in-page";

function Gate() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <RouterProvider router={router} /> : <SignInPage />;
}

export function App() {
  return (
    <Providers>
      <Gate />
    </Providers>
  );
}
