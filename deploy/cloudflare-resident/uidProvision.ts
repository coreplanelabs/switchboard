import { isResidentPoolUser } from "../../src/execution/residentPoolSpends.js";

/** Trusted lifecycle command. The model supplies neither account names nor
 * numeric IDs; native completion must be observed before using the account. */
export function provisionUidCommand(user: string): string[] {
  if (!isResidentPoolUser(user)) throw new Error("UID account is invalid");
  const uid = Number(user.slice(6)) + 2000;
  return [
    "/bin/sh",
    "-eu",
    "-c",
    `name="$1"; uid="$2"; home="/home/$name"
record=$(/usr/bin/getent passwd "$name" || true)
if test -z "$record"; then
  test -z "$(/usr/bin/getent passwd "$uid" || true)"
  if test -e "$home" || test -L "$home"; then exit 1; fi
  /usr/sbin/useradd -m -U -K UID_MAX=2147483647 -K GID_MAX=2147483647 -u "$uid" -s /bin/bash "$name"
fi
test "$(/usr/bin/id -u "$name")" = "$uid"
test "$(/usr/bin/getent passwd "$name" | /usr/bin/cut -d: -f6)" = "$home"
test -d "$home"
test ! -L "$home"
test "$(/usr/bin/stat -c %u "$home")" = "$uid"
/usr/bin/chmod 700 "$home"
printf 'account-ready\\n'`,
    "_",
    user,
    String(uid),
  ];
}
