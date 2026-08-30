import { describe, expect, test } from "bun:test";
import {
  classifyRegularFilePresence,
  type RegularFileLstat,
  type RegularFilePresenceIo,
} from "../src/codex/regular-file-presence";
import {
  classifyOnDiskCatalogSources,
  type CatalogSourcePresenceIo,
} from "../src/codex/catalog/sync";

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function lstat(kind: "file" | "directory" | "symlink" | "other"): RegularFileLstat {
  return {
    isSymbolicLink: () => kind === "symlink",
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
  };
}

function throwingLstat(code: string): RegularFilePresenceIo {
  return {
    lstatSync: () => {
      throw errno(code);
    },
    statSync: () => {
      throw new Error("stat must not run after a failed lstat");
    },
  };
}

describe("regular file presence", () => {
  test("ENOENT and ENOTDIR are proven absence", () => {
    expect(classifyRegularFilePresence("/tmp/missing", throwingLstat("ENOENT"))).toEqual({ kind: "absent" });
    expect(classifyRegularFilePresence("/tmp/missing", throwingLstat("ENOTDIR"))).toEqual({ kind: "absent" });
  });

  test("EACCES and other lstat failures are unreadable, never absent", () => {
    expect(classifyRegularFilePresence("/tmp/denied", throwingLstat("EACCES"))).toEqual({
      kind: "unreadable",
      reason: "stat-failed",
    });
    expect(classifyRegularFilePresence("/tmp/denied", throwingLstat("EPERM"))).toEqual({
      kind: "unreadable",
      reason: "stat-failed",
    });
    expect(classifyRegularFilePresence("/tmp/denied", throwingLstat("EIO"))).toEqual({
      kind: "unreadable",
      reason: "stat-failed",
    });
  });

  test("directory and non-file objects are unreadable", () => {
    expect(classifyRegularFilePresence("/tmp/dir", {
      lstatSync: () => lstat("directory"),
      statSync: () => {
        throw new Error("stat must not run for a non-symlink directory");
      },
    })).toEqual({
      kind: "unreadable",
      reason: "directory",
    });
    expect(classifyRegularFilePresence("/tmp/fifo", {
      lstatSync: () => lstat("other"),
      statSync: () => {
        throw new Error("stat must not run for a non-symlink non-file");
      },
    })).toEqual({
      kind: "unreadable",
      reason: "not-file",
    });
  });

  test("a regular file is present", () => {
    expect(classifyRegularFilePresence("/tmp/file", {
      lstatSync: () => lstat("file"),
      statSync: () => {
        throw new Error("stat must not run for a non-symlink file");
      },
    })).toEqual({
      kind: "regular-file",
    });
  });

  test("a symlink whose followed target is a regular file is present", () => {
    expect(classifyRegularFilePresence("/tmp/link", {
      lstatSync: () => lstat("symlink"),
      statSync: () => lstat("file"),
    })).toEqual({ kind: "regular-file" });
  });

  test("a dangling symlink is unreadable, not proven absence", () => {
    expect(classifyRegularFilePresence("/tmp/link", {
      lstatSync: () => lstat("symlink"),
      statSync: () => {
        throw errno("ENOENT");
      },
    })).toEqual({
      kind: "unreadable",
      reason: "dangling-symlink",
    });
  });

  test("a symlink to a directory or non-file is unreadable", () => {
    expect(classifyRegularFilePresence("/tmp/link", {
      lstatSync: () => lstat("symlink"),
      statSync: () => lstat("directory"),
    })).toEqual({
      kind: "unreadable",
      reason: "directory",
    });
    expect(classifyRegularFilePresence("/tmp/link", {
      lstatSync: () => lstat("symlink"),
      statSync: () => lstat("other"),
    })).toEqual({
      kind: "unreadable",
      reason: "not-file",
    });
  });

  test("a follow-stat permission failure is unreadable, never absent", () => {
    expect(classifyRegularFilePresence("/tmp/link", {
      lstatSync: () => lstat("symlink"),
      statSync: () => {
        throw errno("EACCES");
      },
    })).toEqual({
      kind: "unreadable",
      reason: "stat-failed",
    });
  });
});

describe("on-disk catalog source classification", () => {
  test("EACCES on any candidate is unreadable, never no_source", () => {
    const io: CatalogSourcePresenceIo = {
      lstatSync: () => {
        throw errno("EACCES");
      },
      statSync: () => {
        throw new Error("stat must not run after a failed lstat");
      },
      readFileSync: () => {
        throw new Error("must not read after a failed stat");
      },
    };
    expect(classifyOnDiskCatalogSources("/tmp/catalog.json", io)).toBe("unreadable");
  });

  test("a directory candidate is unreadable", () => {
    expect(classifyOnDiskCatalogSources("/tmp/catalog.json", {
      lstatSync: () => lstat("directory"),
      statSync: () => {
        throw new Error("stat must not run for a non-symlink directory");
      },
      readFileSync: () => {
        throw new Error("must not read a directory as a catalog");
      },
    })).toBe("unreadable");
  });

  test("a valid symlink to a parseable catalog is readable", () => {
    expect(classifyOnDiskCatalogSources("/tmp/catalog.json", {
      lstatSync: (path) => {
        if (path === "/tmp/catalog.json") return lstat("symlink");
        throw errno("ENOENT");
      },
      statSync: (path) => {
        if (path !== "/tmp/catalog.json") throw errno("ENOENT");
        return lstat("file");
      },
      readFileSync: (path) => {
        if (path !== "/tmp/catalog.json") throw errno("ENOENT");
        return JSON.stringify({ models: [{ slug: "gpt-5.5" }] });
      },
    })).toBe("readable");
  });

  test("a dangling catalog symlink is unreadable, not absent", () => {
    expect(classifyOnDiskCatalogSources("/tmp/catalog.json", {
      lstatSync: (path) => {
        if (path === "/tmp/catalog.json") return lstat("symlink");
        throw errno("ENOENT");
      },
      statSync: () => {
        throw errno("ENOENT");
      },
      readFileSync: () => {
        throw new Error("must not read a dangling catalog symlink");
      },
    })).toBe("unreadable");
  });

  test("malformed JSON in a regular file is unreadable", () => {
    expect(classifyOnDiskCatalogSources("/tmp/catalog.json", {
      lstatSync: (path) => {
        if (path === "/tmp/catalog.json") return lstat("file");
        throw errno("ENOENT");
      },
      statSync: () => {
        throw new Error("stat must not run for a non-symlink file");
      },
      readFileSync: (path) => {
        if (path !== "/tmp/catalog.json") throw errno("ENOENT");
        return "{not-json";
      },
    })).toBe("unreadable");
  });

  test("proven absence on every candidate is absent", () => {
    expect(classifyOnDiskCatalogSources("/tmp/catalog.json", {
      lstatSync: () => {
        throw errno("ENOENT");
      },
      statSync: () => {
        throw new Error("stat must not run after a failed lstat");
      },
      readFileSync: () => {
        throw errno("ENOENT");
      },
    })).toBe("absent");
  });

  test("a parseable regular catalog file is readable", () => {
    expect(classifyOnDiskCatalogSources("/tmp/catalog.json", {
      lstatSync: (path) => {
        if (path === "/tmp/catalog.json") return lstat("file");
        throw errno("ENOENT");
      },
      statSync: () => {
        throw new Error("stat must not run for a non-symlink file");
      },
      readFileSync: (path) => {
        if (path !== "/tmp/catalog.json") throw errno("ENOENT");
        return JSON.stringify({ models: [{ slug: "gpt-5.5" }] });
      },
    })).toBe("readable");
  });
});
