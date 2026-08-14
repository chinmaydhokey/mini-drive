const Folder = require('../models/Folder');
const File = require('../models/File');
const AppError = require('../utils/AppError');
const cache = require('../services/cacheService');

/**
 * POST /api/folders
 * Create a new folder.
 */
const createFolder = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { name, parentFolderId } = req.body;

    if (!name || name.trim().length === 0) {
      throw new AppError('Folder name is required.', 400);
    }

    let parentPath = '/';
    let depth = 0;

    // If creating inside another folder, validate parent exists
    if (parentFolderId) {
      const parent = await Folder.findOne({
        _id: parentFolderId,
        userId,
        isDeleted: false,
      });
      if (!parent) {
        throw new AppError('Parent folder not found.', 404);
      }
      parentPath = parent.path;
      depth = parent.depth + 1;

      if (depth > 20) {
        throw new AppError('Maximum folder nesting depth (20) exceeded.', 400);
      }
    }

    // Check for duplicate folder name in the same parent
    const duplicate = await Folder.findOne({
      userId,
      parentFolderId: parentFolderId || null,
      name: name.trim(),
      isDeleted: false,
    });
    if (duplicate) {
      throw new AppError('A folder with this name already exists here.', 409);
    }

    const folder = await Folder.create({
      userId,
      name: name.trim(),
      parentFolderId: parentFolderId || null,
      depth,
      path: '/', // temporary, updated below
    });

    // Set materialized path: parentPath + thisId + /
    folder.path = parentPath === '/'
      ? `/${folder._id}/`
      : `${parentPath}${folder._id}/`;
    await folder.save();

    res.status(201).json({
      success: true,
      data: { folder: folder.toSafeObject() },
    });

    // Invalidate parent folder cache (fire-and-forget)
    cache.invalidateFolder(userId, parentFolderId || 'root');
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/folders/:id
 * Get folder contents (subfolders + files).
 */
const getFolderContents = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { id } = req.params;
    const { sort = 'name', page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));

    // If id is "root", show root-level contents
    const folderId = id === 'root' ? null : id;

    // Validate folder exists (unless root)
    let folder = null;
    if (folderId) {
      folder = await Folder.findOne({ _id: folderId, userId, isDeleted: false });
      if (!folder) {
        throw new AppError('Folder not found.', 404);
      }
    }

    // Get subfolders and files in parallel
    const [subfolders, files, totalFiles] = await Promise.all([
      Folder.find({ userId, parentFolderId: folderId, isDeleted: false })
        .sort(sort)
        .select('-__v'),
      File.find({
        userId,
        folderId: folderId,
        isDeleted: false,
        status: 'AVAILABLE',
      })
        .sort(sort)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .select('-storagePath -storageKey -__v'),
      File.countDocuments({
        userId,
        folderId: folderId,
        isDeleted: false,
        status: 'AVAILABLE',
      }),
    ]);

    // Build breadcrumb path
    const breadcrumbs = [];
    if (folder) {
      let current = folder;
      while (current) {
        breadcrumbs.unshift({ _id: current._id, name: current.name });
        if (current.parentFolderId) {
          current = await Folder.findById(current.parentFolderId).select('_id name parentFolderId');
        } else {
          current = null;
        }
      }
    }

    res.json({
      success: true,
      data: {
        folder: folder ? folder.toSafeObject() : { _id: 'root', name: 'My Drive' },
        breadcrumbs: [{ _id: 'root', name: 'My Drive' }, ...breadcrumbs],
        subfolders: subfolders.map((f) => f.toSafeObject()),
        files,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalFiles,
          pages: Math.ceil(totalFiles / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/folders/:id/tree
 * Get folder tree (recursive descendants).
 */
const getFolderTree = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { id } = req.params;
    const maxDepth = parseInt(req.query.depth, 10) || 5;

    let pathPrefix;

    if (id === 'root') {
      pathPrefix = '/';
    } else {
      const folder = await Folder.findOne({ _id: id, userId, isDeleted: false });
      if (!folder) {
        throw new AppError('Folder not found.', 404);
      }
      pathPrefix = folder.path;
    }

    // Find all descendants using materialized path prefix
    const allFolders = await Folder.find({
      userId,
      isDeleted: false,
      path: { $regex: `^${pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
      depth: { $lte: (id === 'root' ? 0 : (await Folder.findById(id)).depth) + maxDepth },
    })
      .sort('path')
      .select('_id name parentFolderId depth path');

    // Build tree structure
    const tree = buildTree(allFolders, id === 'root' ? null : id);

    res.json({
      success: true,
      data: { tree },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/folders/:id
 * Rename or move a folder.
 */
const updateFolder = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { name, parentFolderId } = req.body;

    const folder = await Folder.findOne({
      _id: req.params.id,
      userId,
      isDeleted: false,
    });

    if (!folder) {
      throw new AppError('Folder not found.', 404);
    }

    // Rename
    if (name !== undefined) {
      if (!name || name.trim().length === 0) {
        throw new AppError('Folder name cannot be empty.', 400);
      }

      // Check for duplicate name in same parent
      const duplicate = await Folder.findOne({
        userId,
        parentFolderId: folder.parentFolderId,
        name: name.trim(),
        isDeleted: false,
        _id: { $ne: folder._id },
      });
      if (duplicate) {
        throw new AppError('A folder with this name already exists here.', 409);
      }

      folder.name = name.trim();
    }

    // Move to different parent
    if (parentFolderId !== undefined) {
      const newParentId = parentFolderId || null;

      // Cannot move folder into itself
      if (newParentId && newParentId.toString() === folder._id.toString()) {
        throw new AppError('Cannot move a folder into itself.', 400);
      }

      // Cannot move into a descendant (would create a cycle)
      if (newParentId) {
        const targetParent = await Folder.findOne({
          _id: newParentId,
          userId,
          isDeleted: false,
        });
        if (!targetParent) {
          throw new AppError('Target folder not found.', 404);
        }

        if (targetParent.path.startsWith(folder.path)) {
          throw new AppError('Cannot move a folder into one of its own subfolders.', 400);
        }

        folder.parentFolderId = newParentId;
        folder.depth = targetParent.depth + 1;

        const newPath = `${targetParent.path}${folder._id}/`;
        const oldPath = folder.path;

        folder.path = newPath;
        await folder.save();

        // Update all descendant paths
        await updateDescendantPaths(userId, oldPath, newPath, folder.depth);
      } else {
        // Moving to root
        const oldPath = folder.path;
        folder.parentFolderId = null;
        folder.depth = 0;
        folder.path = `/${folder._id}/`;
        await folder.save();

        await updateDescendantPaths(userId, oldPath, folder.path, 0);
      }
    } else {
      await folder.save();
    }

    res.json({
      success: true,
      data: { folder: folder.toSafeObject() },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/folders/:id
 * Soft delete a folder and all its contents (recursive).
 */
const deleteFolder = async (req, res, next) => {
  try {
    const { userId } = req.user;

    const folder = await Folder.findOne({
      _id: req.params.id,
      userId,
      isDeleted: false,
    });

    if (!folder) {
      throw new AppError('Folder not found.', 404);
    }

    const now = new Date();

    // Soft delete this folder
    folder.isDeleted = true;
    folder.deletedAt = now;
    await folder.save();

    // Soft delete all descendant folders (using path prefix)
    const descendantFolderResult = await Folder.updateMany(
      {
        userId,
        path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
        isDeleted: false,
      },
      { $set: { isDeleted: true, deletedAt: now } }
    );

    // Get all affected folder IDs (this folder + descendants)
    const affectedFolderIds = [folder._id];
    const descendantFolders = await Folder.find({
      userId,
      path: { $regex: `^${folder.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
    }).select('_id');
    affectedFolderIds.push(...descendantFolders.map((f) => f._id));

    // Soft delete all files in affected folders
    const fileResult = await File.updateMany(
      {
        userId,
        folderId: { $in: affectedFolderIds },
        isDeleted: false,
      },
      { $set: { isDeleted: true, deletedAt: now, status: 'DELETED' } }
    );

    res.json({
      success: true,
      data: {
        message: 'Folder and contents moved to trash.',
        folderId: folder._id,
        affectedFolders: descendantFolderResult.modifiedCount + 1,
        affectedFiles: fileResult.modifiedCount,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ── Helpers ──────────────────────────────────────────────────

/**
 * Update all descendant folder paths when a folder is moved.
 */
async function updateDescendantPaths(userId, oldPathPrefix, newPathPrefix, newParentDepth) {
  const descendants = await Folder.find({
    userId,
    path: { $regex: `^${oldPathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
    isDeleted: false,
  });

  for (const desc of descendants) {
    desc.path = desc.path.replace(oldPathPrefix, newPathPrefix);
    // Recalculate depth based on number of segments in path
    desc.depth = (desc.path.match(/\//g) || []).length - 2; // -2 for leading and trailing /
    await desc.save();
  }
}

/**
 * Build a nested tree structure from a flat list of folders.
 */
function buildTree(folders, rootId) {
  const map = {};
  const roots = [];

  folders.forEach((f) => {
    map[f._id.toString()] = { ...f.toObject(), children: [] };
  });

  folders.forEach((f) => {
    const node = map[f._id.toString()];
    const parentKey = f.parentFolderId ? f.parentFolderId.toString() : null;

    if (parentKey === (rootId ? rootId.toString() : null)) {
      roots.push(node);
    } else if (parentKey && map[parentKey]) {
      map[parentKey].children.push(node);
    }
  });

  return roots;
}

module.exports = {
  createFolder,
  getFolderContents,
  getFolderTree,
  updateFolder,
  deleteFolder,
};
