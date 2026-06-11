import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import { api, setManagementProfile } from "@/lib/api";
import { ProfileContext } from "@/contexts/profile-context";

/**
 * Machine-level management-profile scope.
 *
 * One switcher (rendered in the sidebar) decides which profile every
 * management page reads/writes. The selection lives in the URL
 * (`?profile=<name>`) so it survives refresh and deep-links, and is mirrored
 * into the api module so `fetchJSON` transparently appends it to the
 * profile-scoped endpoint families. "" = the dashboard's own profile.
 *
 * This exists because "Set as active" on the Profiles page only flips the
 * sticky active_profile file (future CLI/gateway runs) — it cannot retarget
 * the running dashboard. The switcher is the dashboard's own, visible,
 * write-target selector.
 */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [profiles, setProfiles] = useState<string[]>([]);
  const [currentProfile, setCurrentProfile] = useState("default");

  const profile = searchParams.get("profile") ?? "";

  // Mirror into the api module synchronously on every render where it
  // changed, so fetches fired by child effects in the same commit see it.
  setManagementProfile(profile);

  useEffect(() => {
    api
      .getProfiles()
      .then((res) => setProfiles(res.profiles.map((p) => p.name)))
      .catch(() => {});
    api
      .getActiveProfile()
      .then((info) => setCurrentProfile(info.current || "default"))
      .catch(() => {});
  }, []);

  const setProfile = useCallback(
    (name: string) => {
      setManagementProfile(name);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (name) next.set("profile", name);
          else next.delete("profile");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const value = useMemo(
    () => ({ profile, currentProfile, profiles, setProfile }),
    [profile, currentProfile, profiles, setProfile],
  );

  return (
    <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>
  );
}
